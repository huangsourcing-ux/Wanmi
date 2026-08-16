import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { realnameTemplateFixture } from '../fixtures/realname'
import { findOrCreateUniqueFixture } from '../test-cleanup'
import { getFixturePayload } from './redirect-fixture'

export const realnameDocumentFixturePhone = '13900004303'
const normalizedFixturePhone = `+86${realnameDocumentFixturePhone}`
const statePath = resolve(process.cwd(), 'test-results/realname-document-fixture.json')

type FixtureState = { customerId: number | string; templateId: number | string }

export async function createRealnameDocumentFixture() {
  const payload = await getFixturePayload()
  const { value: customer } = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'customers',
        data: {
          capabilityRestrictions: [],
          phone: normalizedFixturePhone,
          phoneMasked: '+86139****4303',
          status: 'active',
        },
        overrideAccess: true,
      }),
    find: async () => {
      const existing = await payload.find({
        collection: 'customers',
        limit: 1,
        overrideAccess: true,
        where: { phone: { equals: normalizedFixturePhone } },
      })
      return existing.docs[0]
    },
    path: 'phone',
    tableName: 'customers',
  })
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: 'E2E 私有证件模板' }),
      customer: customer.id,
      providerReviewState: 'unsubmitted',
      status: 'draft',
    },
    overrideAccess: true,
  })
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(
    statePath,
    JSON.stringify({ customerId: customer.id, templateId: template.id } satisfies FixtureState),
    'utf8',
  )
}

export async function readRealnameDocumentFixture(): Promise<FixtureState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as FixtureState
}

export async function removeRealnameDocumentFixture() {
  const state = await readRealnameDocumentFixture().catch(() => undefined)
  if (!state) return
  const payload = await getFixturePayload()
  const documents = await payload.find({
    collection: 'realnameDocuments',
    limit: 100,
    overrideAccess: true,
    where: { template: { equals: state.templateId } },
  })
  for (const document of documents.docs) {
    await payload.delete({ collection: 'realnameDocuments', id: document.id, overrideAccess: true })
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 100,
    overrideAccess: true,
    where: { traceId: { contains: 'e2e-d4-private-document' } },
  })
  for (const audit of audits.docs) {
    await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
  }
  await payload
    .delete({ collection: 'realnameTemplates', id: state.templateId, overrideAccess: true })
    .catch(() => undefined)
  const sessions = await payload.find({
    collection: 'customerSessions',
    limit: 100,
    overrideAccess: true,
    where: { customer: { equals: state.customerId } },
  })
  for (const session of sessions.docs) {
    await payload.delete({ collection: 'customerSessions', id: session.id, overrideAccess: true })
  }
  for (const collection of ['consentRecords', 'customerIdentities'] as const) {
    await payload.delete({
      collection,
      overrideAccess: true,
      where: { customer: { equals: state.customerId } },
    })
  }
  const challenges = await payload.find({
    collection: 'smsChallenges',
    limit: 100,
    overrideAccess: true,
    where: { phone: { equals: normalizedFixturePhone } },
  })
  for (const challenge of challenges.docs) {
    await payload.delete({ collection: 'smsChallenges', id: challenge.id, overrideAccess: true })
  }
  await payload
    .delete({ collection: 'customers', id: state.customerId, overrideAccess: true })
    .catch(() => undefined)
  await unlink(statePath).catch(() => undefined)
}
