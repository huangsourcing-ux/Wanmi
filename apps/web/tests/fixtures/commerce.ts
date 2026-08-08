import { randomUUID } from 'node:crypto'

export function fulfillmentQuoteSnapshotFixture(input: {
  amountMinor?: number
  customerId: number | string
  domainAscii: string
  expiresAt?: string
  quoteId: number | string
}) {
  const now = new Date().toISOString()
  const amountMinor = input.amountMinor ?? 120
  return {
    availabilityObservedAt: now,
    availabilityRequestId: `availability-${randomUUID()}`,
    calculation: {
      registrationPriceFen: amountMinor,
      renewalPriceFen: amountMinor,
      upstreamRegistrationPriceFen: amountMinor,
      upstreamRenewalPriceFen: amountMinor,
    },
    createdTraceId: `trace-${randomUUID()}`,
    currency: 'CNY' as const,
    customerId: String(input.customerId),
    domainAscii: input.domainAscii,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 300_000).toISOString(),
    orderAvailability: { observedAt: now, requestId: `order-availability-${randomUUID()}` },
    providerCacheStatus: 'miss' as const,
    providerObservedAt: now,
    providerProductId: `product-${randomUUID()}`,
    providerRequestId: `price-${randomUUID()}`,
    quoteId: input.quoteId,
    quoteIntegrityHash: '0'.repeat(64),
    quoteRef: randomUUID(),
    quotedAt: now,
    schemaVersion: 1 as const,
    sourceCalculationHash: '1'.repeat(64),
    sourcePriceSnapshotRef: randomUUID(),
    tld: input.domainAscii.split('.').at(-1)!,
    upstreamCostMinor: amountMinor,
    userPriceMinor: amountMinor,
    years: 1,
  }
}
