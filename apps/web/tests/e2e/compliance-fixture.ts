import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { PUBLIC_COMPLIANCE_SETTING_KEY } from '../../src/lib/public-compliance'
import { getFixturePayload } from './redirect-fixture'

const statePath = resolve(process.cwd(), 'test-results/compliance-fixture.json')

type ComplianceFixtureState = {
  original: null | {
    description?: null | string
    value: unknown
  }
}

async function readState(): Promise<ComplianceFixtureState | undefined> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as ComplianceFixtureState
  } catch {
    return undefined
  }
}

async function findSetting() {
  const payload = await getFixturePayload()
  const found = await payload.find({
    collection: 'siteSettings',
    limit: 1,
    overrideAccess: true,
    where: { key: { equals: PUBLIC_COMPLIANCE_SETTING_KEY } },
  })
  return { payload, setting: found.docs[0] }
}

export async function createComplianceFixture() {
  if (await readState()) await removeComplianceFixture()

  const { payload, setting } = await findSetting()
  const state: ComplianceFixtureState = {
    original: setting ? { description: setting.description, value: setting.value } : null,
  }
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state), 'utf8')

  const data = {
    description: 'D8-01 E2E 公开合规展示配置',
    key: PUBLIC_COMPLIANCE_SETTING_KEY,
    value: {
      icpRegistrationNumber: '渝ICP备18017546-13',
      registrarName: '西部数码',
      schemaVersion: 1 as const,
      showPrelaunchNotice: false,
    },
  }
  if (setting) {
    await payload.update({
      collection: 'siteSettings',
      data,
      id: setting.id,
      overrideAccess: true,
    })
    return
  }
  await payload.create({ collection: 'siteSettings', data, overrideAccess: true })
}

export async function removeComplianceFixture() {
  const state = await readState()
  if (!state) return

  const { payload, setting } = await findSetting()
  if (state.original) {
    const data = {
      description: state.original.description,
      key: PUBLIC_COMPLIANCE_SETTING_KEY,
      value: state.original.value as Record<string, unknown>,
    }
    if (setting) {
      await payload.update({
        collection: 'siteSettings',
        data,
        id: setting.id,
        overrideAccess: true,
      })
    } else {
      await payload.create({ collection: 'siteSettings', data, overrideAccess: true })
    }
  } else if (setting) {
    await payload.delete({ collection: 'siteSettings', id: setting.id, overrideAccess: true })
  }
  await unlink(statePath).catch(() => undefined)
}
