import { describe, expect, it, vi } from 'vitest'

import {
  createRenewalMandateChangeHandler,
  createRenewalMandateGetHandler,
} from '@/app/api/v1/domains/[assetId]/renewal-mandate/route'
import { createRenewalMandatePreviewHandler } from '@/app/api/v1/domains/[assetId]/renewal-mandate/preview/route'
import {
  renewalMandateChangeRequestSchema,
  renewalMandatePreviewRequestSchema,
} from '@/schemas/domains'

const customer = { collection: 'customers' as const, id: 42, status: 'active' }
const req = { user: customer } as never
const routeContext = { params: Promise.resolve({ assetId: '7' }) }

function context() {
  return Promise.resolve({ customer, req })
}

function jsonRequest(body: unknown, method: 'DELETE' | 'POST' | 'PUT') {
  return new Request('http://wanmi.local/api/v1/domains/7/renewal-mandate', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  })
}

function mandateResult(eventType: 'authorized' | 'revoked' = 'authorized') {
  return {
    data: {
      mandate: {
        authorizedAt: '2027-08-01T12:00:00.000Z',
        currency: 'CNY' as const,
        domainAscii: 'example.com',
        eventType,
        id: '11',
        maxDebitFen: 3_500,
        revision: eventType === 'authorized' ? 1 : 2,
        ...(eventType === 'revoked' ? { revokedAt: '2027-08-02T12:00:00.000Z' } : {}),
        rulesVersion: '2026-08-18.1',
        scope: 'renew_one_year' as const,
        validUntil: '2028-08-01T12:00:00.000Z',
      },
    },
    state: 'ready' as const,
  }
}

describe('D9-C-2 renewal mandate route contracts', () => {
  it('requires a finite positive maximum, bounded validity, and literal second confirmation', () => {
    expect(
      renewalMandatePreviewRequestSchema.safeParse({
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
      }).success,
    ).toBe(true)
    for (const maxDebitFen of [
      undefined,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        renewalMandatePreviewRequestSchema.safeParse({
          action: 'authorize',
          maxDebitFen,
          scope: 'renew_one_year',
          validUntil: '2028-08-01T12:00:00.000Z',
        }).success,
      ).toBe(false)
    }
    for (const candidate of [
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_forever',
        validUntil: '2028-08-01T12:00:00.000Z',
      },
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
      },
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
        validUntil: 'not-a-date',
      },
    ]) {
      expect(renewalMandatePreviewRequestSchema.safeParse(candidate).success).toBe(false)
    }
    expect(
      renewalMandateChangeRequestSchema.safeParse({
        confirmed: false,
        deviceId: 'renewal-device-00000001',
        previewToken: 'p'.repeat(80),
        stepUpToken: 's'.repeat(43),
      }).success,
    ).toBe(false)
    expect(
      renewalMandateChangeRequestSchema.safeParse({
        confirmed: true,
        deviceId: 'renewal-device-00000001',
        previewToken: 'p'.repeat(80),
        stepUpToken: 's'.repeat(43),
      }).success,
    ).toBe(true)
    for (const candidate of [
      {
        confirmed: true,
        previewToken: 'p'.repeat(80),
        stepUpToken: 's'.repeat(43),
      },
      {
        confirmed: true,
        deviceId: 'short',
        previewToken: 'p'.repeat(80),
        stepUpToken: 's'.repeat(43),
      },
      {
        confirmed: true,
        deviceId: 'renewal-device-00000001',
        previewToken: 'short',
        stepUpToken: 's'.repeat(43),
      },
      {
        confirmed: true,
        deviceId: 'renewal-device-00000001',
        previewToken: 'p'.repeat(4_097),
        stepUpToken: 's'.repeat(43),
      },
      {
        confirmed: true,
        deviceId: 'renewal-device-00000001',
        previewToken: 'p'.repeat(80),
        stepUpToken: 'invalid token',
      },
    ]) {
      expect(renewalMandateChangeRequestSchema.safeParse(candidate).success).toBe(false)
    }
  })

  it('binds authorize and revoke endpoints to different expected actions', async () => {
    const change = vi
      .fn()
      .mockResolvedValueOnce(mandateResult('authorized'))
      .mockResolvedValueOnce(mandateResult('revoked'))
    const body = {
      confirmed: true,
      deviceId: 'renewal-device-00000001',
      previewToken: 'p'.repeat(80),
      stepUpToken: 's'.repeat(43),
    }
    const authorize = await createRenewalMandateChangeHandler(
      { change, resolveContext: context },
      'authorize',
    )(jsonRequest(body, 'PUT'), routeContext)
    const revoke = await createRenewalMandateChangeHandler(
      { change, resolveContext: context },
      'revoke',
    )(jsonRequest(body, 'DELETE'), routeContext)

    expect(authorize.status).toBe(200)
    expect(revoke.status).toBe(200)
    expect(change.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ customer, expectedAction: 'authorize' }),
    )
    expect(change.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ customer, expectedAction: 'revoke' }),
    )
  })

  it('rejects malformed previews before service execution and exposes only the authorized view', async () => {
    const preview = vi.fn().mockResolvedValue({
      data: {
        action: 'authorize',
        domainAscii: 'example.com',
        firstAttemptDays: 7,
        maxDebitFen: 3_500,
        previewExpiresAt: '2027-08-01T12:05:00.000Z',
        previewToken: 'p'.repeat(80),
        reminderLimit: 2,
        retryDays: [3, 1],
        rulesVersion: '2026-08-18.1',
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
        warning: '确认后仅在授权上限内且余额充足时自动续费。',
      },
      state: 'ready',
    })
    const malformed = await createRenewalMandatePreviewHandler({
      preview,
      resolveContext: context,
    })(jsonRequest({ action: 'authorize', maxDebitFen: 0 }, 'POST'), routeContext)
    expect(malformed.status).toBe(400)
    expect(preview).not.toHaveBeenCalled()

    const get = vi.fn().mockResolvedValue(mandateResult())
    const response = await createRenewalMandateGetHandler({ get, resolveContext: context })(
      new Request('http://wanmi.local/api/v1/domains/7/renewal-mandate'),
      routeContext,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { mandate: { domainAscii: 'example.com', maxDebitFen: 3_500 } },
      state: 'ready',
    })
  })
})
