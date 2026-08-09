import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AdminRole } from '@/lib/domain'
import { getEnv, resetEnvForTests } from '@/lib/env'
import type { Admin } from '@/payload-types'
import { PUBLIC_FORM_CONTRACTS } from '@/services/forms/form-contracts'
import { submitPublicForm } from '@/services/forms/form-submissions'
import { readManagedPublicForm } from '@/services/forms/read-public-form'

import { ensureAnchorSystemAdmin, ignorePayloadNotFound } from '../test-cleanup'

const fixturePrefix = `d3-form-${randomUUID()}`
const createdSubmissionIds: Array<number | string> = []
let payload: Payload
let systemAdmin: Admin
let systemAdminReq: PayloadRequest

function admin(role: AdminRole, id: number) {
  return {
    collection: 'admins' as const,
    email: `${role}-${id}@example.test`,
    id,
    roles: [role],
    status: 'active' as const,
  }
}

async function rememberLatest(traceId: string) {
  const result = await payload.find({
    collection: 'form-submissions',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { traceId: { equals: traceId } },
  })
  const submission = result.docs[0]
  if (!submission) throw new Error(`Missing form submission fixture ${traceId}`)
  createdSubmissionIds.push(submission.id)
  return submission
}

beforeAll(async () => {
  payload = await getPayload({ config })
  systemAdmin = await ensureAnchorSystemAdmin(payload)
  systemAdminReq = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-status` }) } },
    payload,
  )
  systemAdminReq.user = { ...systemAdmin, collection: 'admins' }
})

afterAll(async () => {
  for (const id of createdSubmissionIds.reverse()) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'form-submissions', id, overrideAccess: true }),
    )
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    depth: 0,
    limit: 1_000,
    overrideAccess: true,
    where: {
      and: [
        { action: { equals: 'form_submission.status_changed' } },
        { targetType: { equals: 'form-submission' } },
        { traceId: { equals: `${fixturePrefix}-status` } },
      ],
    },
  })
  for (const audit of audits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  await payload.db.destroy?.()
})

describe('D3-05 Form Builder entries', () => {
  it('loads exactly one approved plugin form for each public purpose', async () => {
    for (const purpose of ['contact', 'feedback', 'request'] as const) {
      const form = await readManagedPublicForm(payload, purpose)
      expect(form?.purpose).toBe(purpose)
      expect(form?.fields.map(({ name }) => name)).toEqual(
        PUBLIC_FORM_CONTRACTS[purpose].fields.map(({ name }) => name),
      )
      expect(JSON.stringify(form)).not.toMatch(/payment|refund|realname|upload|file/u)
    }
  })

  it('sanitizes submissions and enforces masked operational reads with system-only status changes', async () => {
    const traceId = `${fixturePrefix}-rbac`
    await submitPublicForm(
      payload,
      {
        purpose: 'feedback',
        values: {
          contact: 'owner@example.test',
          feedbackType: 'tool_error',
          message: 'wanmi.net 查询结果需要复核，请联系 owner@example.test 或 13800138000',
          pagePath: '/tools/domain-search?q=wanmi.net',
          requestId: `${fixturePrefix}-request`,
          tool: 'domain-search',
        },
      },
      new Headers({ 'x-forwarded-for': '192.0.2.51' }),
      traceId,
    )
    const submission = await rememberLatest(traceId)
    expect(submission.summary).toBe('[域名已隐藏] 查询结果需要复核,请联系 o***@*** 或 138****8000')
    expect(submission.pagePath).toBe('/tools/domain-search')
    expect(JSON.stringify(submission.submissionData)).not.toContain('wanmi.net')

    const adOperator = admin('ad_operator', 3101)
    const analyst = admin('analyst', 3102)
    const systemAdminUser = { ...systemAdmin, collection: 'admins' as const }
    for (const reader of [adOperator, analyst]) {
      const visible = await payload.findByID({
        collection: 'form-submissions',
        id: submission.id,
        overrideAccess: false,
        user: reader as never,
      })
      expect(visible).toMatchObject({
        contactMasked: 'o***@***',
        purpose: 'feedback',
        status: 'new',
        summary: '[域名已隐藏] 查询结果需要复核,请联系 o***@*** 或 138****8000',
      })
      expect(visible.submissionData).toEqual([])
      expect(visible).not.toHaveProperty('clientKeyHash')
      await expect(
        payload.update({
          collection: 'form-submissions',
          data: { status: 'reviewed' },
          id: submission.id,
          overrideAccess: false,
          user: reader as never,
        }),
      ).rejects.toThrow()
    }

    const systemView = await payload.findByID({
      collection: 'form-submissions',
      id: submission.id,
      overrideAccess: false,
      user: systemAdminUser,
    })
    expect(systemView.submissionData).toContainEqual(
      expect.objectContaining({ field: 'contact', value: 'owner@example.test' }),
    )
    const reviewed = await payload.update({
      collection: 'form-submissions',
      data: { status: 'reviewed', summary: 'must-not-overwrite' },
      id: submission.id,
      overrideAccess: false,
      req: systemAdminReq,
      user: systemAdminUser,
    })
    expect(reviewed.status).toBe('reviewed')
    expect(reviewed.summary).toBe('[域名已隐藏] 查询结果需要复核,请联系 o***@*** 或 138****8000')
    const reviewedBy = reviewed.statusUpdatedBy
    expect(reviewedBy && typeof reviewedBy === 'object' ? reviewedBy.id : reviewedBy).toBe(
      systemAdmin.id,
    )
    await payload.update({
      collection: 'form-submissions',
      data: { status: 'closed' },
      id: submission.id,
      overrideAccess: false,
      req: systemAdminReq,
      user: systemAdminUser,
    })
    await expect(
      payload.update({
        collection: 'form-submissions',
        data: { status: 'reviewed' },
        id: submission.id,
        overrideAccess: false,
        req: systemAdminReq,
        user: systemAdminUser,
      }),
    ).rejects.toThrow(/状态迁移/u)

    const audits = await payload.find({
      collection: 'auditLogs',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'form_submission.status_changed' } },
          { targetId: { equals: String(submission.id) } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(2)
    expect(JSON.stringify(audits.docs)).not.toMatch(/owner@example|wanmi\.net/u)
  })

  it('rejects raw HTML, unapproved fields and generic REST/Local API creation', async () => {
    const rejectedTraceIds = [`${fixturePrefix}-html`, `${fixturePrefix}-order`]
    const before = await payload.count({
      collection: 'form-submissions',
      overrideAccess: true,
      where: { traceId: { in: rejectedTraceIds } },
    })
    expect(before.totalDocs).toBe(0)
    await expect(
      submitPublicForm(
        payload,
        {
          purpose: 'contact',
          values: {
            contact: 'safe@example.test',
            message: '<img src=x onerror=alert(1)>',
            topic: 'general',
          },
        },
        new Headers({ 'x-forwarded-for': '192.0.2.52' }),
        rejectedTraceIds[0]!,
      ),
    ).rejects.toThrow(/纯文本/u)
    await expect(
      submitPublicForm(
        payload,
        {
          purpose: 'contact',
          values: {
            contact: 'safe@example.test',
            message: '咨询',
            orderId: 'forbidden',
            topic: 'general',
          },
        },
        new Headers({ 'x-forwarded-for': '192.0.2.52' }),
        rejectedTraceIds[1]!,
      ),
    ).rejects.toThrow(/未批准字段/u)
    const form = await payload.find({
      collection: 'forms',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { purpose: { equals: 'contact' } },
    })
    await expect(
      payload.create({
        collection: 'form-submissions',
        data: { form: form.docs[0]!.id, submissionData: [] } as never,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    const after = await payload.count({
      collection: 'form-submissions',
      overrideAccess: true,
      where: { traceId: { in: rejectedTraceIds } },
    })
    expect(after.totalDocs).toBe(0)
  })

  it('rate limits by HMAC client key and returns a stable 429 error', async () => {
    const previous = process.env.FORM_SUBMISSION_IP_LIMIT_PER_HOUR
    process.env.FORM_SUBMISSION_IP_LIMIT_PER_HOUR = '1'
    resetEnvForTests()
    const headers = new Headers({ 'x-forwarded-for': '192.0.2.53' })
    const firstTrace = `${fixturePrefix}-limit-first`
    try {
      await submitPublicForm(
        payload,
        {
          purpose: 'contact',
          values: { contact: 'limit@example.test', message: '第一次', topic: 'general' },
        },
        headers,
        firstTrace,
      )
      await rememberLatest(firstTrace)
      await expect(
        submitPublicForm(
          payload,
          {
            purpose: 'contact',
            values: { contact: 'limit@example.test', message: '第二次', topic: 'general' },
          },
          headers,
          `${fixturePrefix}-limit-second`,
        ),
      ).rejects.toMatchObject({ code: 'FORM_RATE_LIMITED', status: 429 })
    } finally {
      if (previous === undefined) delete process.env.FORM_SUBMISSION_IP_LIMIT_PER_HOUR
      else process.env.FORM_SUBMISSION_IP_LIMIT_PER_HOUR = previous
      resetEnvForTests()
      getEnv()
    }
  })
})
