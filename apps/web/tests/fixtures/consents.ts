import { createLocalReq, type Payload } from 'payload'

import { appendConsentAcceptance } from '@/services/auth/registration-consents'

export async function grantSensitivePersonalInformationConsent(
  payload: Payload,
  customerId: number,
  traceId: string,
) {
  const headers = new Headers({
    'user-agent': 'Wanmi-Test-Fixture/consent',
    'x-forwarded-for': '198.51.100.90',
    'x-request-id': traceId,
  })
  const req = await createLocalReq({ req: { headers } }, payload)
  return appendConsentAcceptance(req, {
    acceptedAt: new Date().toISOString(),
    consentType: 'sensitive_personal_information',
    customerId,
    headers,
    source: 'account_privacy_center',
  })
}
