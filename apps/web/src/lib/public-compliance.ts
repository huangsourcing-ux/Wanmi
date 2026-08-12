import { cache } from 'react'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import { z } from 'zod'

import { logger } from '@/lib/logging'

export const PUBLIC_COMPLIANCE_SETTING_KEY = 'compliance.public-disclosures.v1'
export const ICP_REGISTRATION_URL = 'https://beian.miit.gov.cn/'

const registrationNumberSchema = z.string().trim().min(4).max(80)

const publicSecurityRegistrationSchema = z
  .object({
    number: registrationNumberSchema,
    url: z
      .string()
      .trim()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value)
          return (
            url.origin === 'https://www.beian.gov.cn' &&
            url.pathname === '/portal/registerSystemInfo' &&
            !url.username &&
            !url.password
          )
        } catch {
          return false
        }
      }, '公安联网备案链接必须指向 beian.gov.cn 的备案详情页'),
  })
  .strict()

export const publicComplianceSettingSchema = z
  .object({
    icpRegistrationNumber: registrationNumberSchema.optional(),
    publicSecurityRegistration: publicSecurityRegistrationSchema.optional(),
    registrarName: z.string().trim().min(2).max(80).optional(),
    schemaVersion: z.literal(1),
    showPrelaunchNotice: z.boolean(),
  })
  .strict()

export type PublicComplianceConfig = z.infer<typeof publicComplianceSettingSchema>

export const DEFAULT_PUBLIC_COMPLIANCE_CONFIG: PublicComplianceConfig = {
  schemaVersion: 1,
  showPrelaunchNotice: true,
}

type PublicCompliancePayload = Pick<Payload, 'find'>

type SiteSettingDocument = {
  value: unknown
}

export async function readPublicComplianceConfig(
  payload: PublicCompliancePayload,
): Promise<PublicComplianceConfig> {
  const result = await payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    where: { key: { equals: PUBLIC_COMPLIANCE_SETTING_KEY } },
  })
  const document = result.docs[0] as SiteSettingDocument | undefined
  if (!document) return DEFAULT_PUBLIC_COMPLIANCE_CONFIG

  const parsed = publicComplianceSettingSchema.safeParse(document.value)
  if (!parsed.success) {
    logger.warn({
      msg: 'Public compliance setting is invalid; rendering no registration identifiers',
      settingKey: PUBLIC_COMPLIANCE_SETTING_KEY,
    })
    return DEFAULT_PUBLIC_COMPLIANCE_CONFIG
  }
  return parsed.data
}

async function loadPublicComplianceConfig(): Promise<PublicComplianceConfig> {
  try {
    const payload = await getPayload({ config })
    return await readPublicComplianceConfig(payload)
  } catch (error) {
    logger.warn({
      errorName: error instanceof Error ? error.name : 'UnknownError',
      msg: 'Public compliance setting is unavailable; rendering safe defaults',
    })
    return DEFAULT_PUBLIC_COMPLIANCE_CONFIG
  }
}

export const getPublicComplianceConfig = cache(loadPublicComplianceConfig)
