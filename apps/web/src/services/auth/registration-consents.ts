import { createHash } from 'node:crypto'

import { LEGAL_DOCUMENTS } from '@/lib/legal-config'

type RegistrationConsentType = 'privacy_policy' | 'service_terms'

const versions: Record<RegistrationConsentType, string> = {
  privacy_policy: 'legal-config-privacy-2026-08-12',
  service_terms: 'legal-config-terms-2026-08-12',
}

function legalSlug(type: RegistrationConsentType): 'privacy' | 'terms' {
  return type === 'privacy_policy' ? 'privacy' : 'terms'
}

export function registrationConsentDocument(type: RegistrationConsentType): {
  documentHash: string
  documentVersion: string
} {
  const document = LEGAL_DOCUMENTS.find((candidate) => candidate.slug === legalSlug(type))
  if (!document) throw new Error(`Registration legal document is missing: ${type}`)
  return {
    documentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    documentVersion: versions[type],
  }
}
