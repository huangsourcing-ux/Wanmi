import type { PayloadRequest } from 'payload'

export async function recordCustomerSecurityEvent(
  req: PayloadRequest,
  customerId: number,
  event: string,
  safeMetadata?: Record<string, unknown>,
): Promise<void> {
  await req.payload.create({
    collection: 'customerSecurityEvents',
    data: {
      customer: customerId,
      event,
      occurredAt: new Date().toISOString(),
      safeMetadata,
    },
    overrideAccess: true,
    req,
  })
}
