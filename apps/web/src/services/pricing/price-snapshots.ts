import { createHash, randomUUID } from 'node:crypto'

import type { Payload } from 'payload'

import { AppError } from '@/lib/errors'
import type { PriceSnapshot } from '@/payload-types'
import {
  calculateTldPrice,
  PRICE_CALCULATION_VERSION,
  PRICE_SNAPSHOT_SCHEMA_VERSION,
  type PriceCalculation,
  type PricingRule,
} from '@/services/pricing/price-calculation'

export type PriceSnapshotInput = {
  calculation: PriceCalculation
  providerCacheExpiresAt?: string
  providerCacheStatus: 'hit' | 'miss'
  providerObservedAt: string
  providerProductId: string
  providerRequestId: string
  representativeDomainAscii: string
  tld: string
  traceId: string
}

export type StoredPriceSnapshot = PriceSnapshotInput & {
  calculationHash: string
  createdAt: string
  snapshotRef: string
}

export interface PriceSnapshotStore {
  findLatest(input: {
    ruleKey: string
    ruleVersion: PricingRule['version']
    tld: string
  }): Promise<StoredPriceSnapshot | undefined>
  record(input: PriceSnapshotInput): Promise<StoredPriceSnapshot>
}

function canonicalSnapshot(input: PriceSnapshotInput) {
  const rule =
    input.calculation.rule.mode === 'fixed'
      ? {
          fixedAmountFen: input.calculation.rule.fixedAmountFen,
          key: input.calculation.rule.key,
          mode: input.calculation.rule.mode,
          source: input.calculation.rule.source,
          tld: input.calculation.rule.tld,
          version: input.calculation.rule.version,
        }
      : {
          key: input.calculation.rule.key,
          mode: input.calculation.rule.mode,
          percentageBasisPoints: input.calculation.rule.percentageBasisPoints,
          source: input.calculation.rule.source,
          tld: input.calculation.rule.tld,
          version: input.calculation.rule.version,
        }
  return {
    calculation: {
      calculationFormula: input.calculation.calculationFormula,
      calculationVersion: input.calculation.calculationVersion,
      currency: input.calculation.currency,
      oneYearTotalFen: input.calculation.oneYearTotalFen,
      registrationPriceFen: input.calculation.registrationPriceFen,
      renewalPriceFen: input.calculation.renewalPriceFen,
      rule,
      threeYearTotalFen: input.calculation.threeYearTotalFen,
      upstreamRegistrationPriceFen: input.calculation.upstreamRegistrationPriceFen,
      upstreamRenewalPriceFen: input.calculation.upstreamRenewalPriceFen,
    },
    priceClass: 'standard',
    provider: 'westdigital_fixture',
    providerObservedAt: input.providerObservedAt,
    providerProductId: input.providerProductId,
    providerRequestId: input.providerRequestId,
    representativeDomainAscii: input.representativeDomainAscii,
    roundingMode: 'half_up_to_fen',
    schemaVersion: PRICE_SNAPSHOT_SCHEMA_VERSION,
    tld: input.tld,
  }
}

export function createPriceCalculationHash(input: PriceSnapshotInput): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalSnapshot(input)))
    .digest('hex')
}

function ruleFromDocument(doc: PriceSnapshot): PricingRule {
  if (doc.ruleVersion !== 1) {
    throw new AppError('PRICE_SNAPSHOT_VERSION_UNSUPPORTED', '价格快照规则版本不受支持', 500)
  }
  if (doc.ruleMode === 'fixed') {
    if (doc.ruleFixedAmountMinor === null || doc.ruleFixedAmountMinor === undefined) {
      throw new AppError('PRICE_SNAPSHOT_RULE_INCOMPLETE', '价格快照缺少固定加价金额', 500)
    }
    return {
      fixedAmountFen: doc.ruleFixedAmountMinor,
      key: doc.ruleKey,
      mode: 'fixed',
      source: doc.ruleSource,
      tld: doc.tld,
      version: 1,
    }
  }
  if (doc.rulePercentageBasisPoints === null || doc.rulePercentageBasisPoints === undefined) {
    throw new AppError('PRICE_SNAPSHOT_RULE_INCOMPLETE', '价格快照缺少比例加价基点', 500)
  }
  return {
    key: doc.ruleKey,
    mode: 'percentage',
    percentageBasisPoints: doc.rulePercentageBasisPoints,
    source: doc.ruleSource,
    tld: doc.tld,
    version: 1,
  }
}

function fromDocument(doc: PriceSnapshot): StoredPriceSnapshot {
  if (
    doc.schemaVersion !== PRICE_SNAPSHOT_SCHEMA_VERSION ||
    doc.calculationVersion !== PRICE_CALCULATION_VERSION
  ) {
    throw new AppError('PRICE_SNAPSHOT_VERSION_UNSUPPORTED', '价格快照计算版本不受支持', 500)
  }
  return {
    calculation: {
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      currency: 'CNY',
      oneYearTotalFen: doc.oneYearTotalMinor,
      registrationPriceFen: doc.registrationPriceMinor,
      renewalPriceFen: doc.renewalPriceMinor,
      rule: ruleFromDocument(doc),
      threeYearTotalFen: doc.threeYearTotalMinor,
      upstreamRegistrationPriceFen: doc.upstreamRegistrationPriceMinor,
      upstreamRenewalPriceFen: doc.upstreamRenewalPriceMinor,
    },
    calculationHash: doc.calculationHash,
    createdAt: doc.createdAt,
    ...(doc.providerCacheExpiresAt ? { providerCacheExpiresAt: doc.providerCacheExpiresAt } : {}),
    providerCacheStatus: doc.providerCacheStatus,
    providerObservedAt: doc.providerObservedAt,
    providerProductId: doc.providerProductId,
    providerRequestId: doc.providerRequestId,
    representativeDomainAscii: doc.representativeDomainAscii,
    snapshotRef: doc.snapshotRef,
    tld: doc.tld,
    traceId: doc.createdTraceId,
  }
}

export class PayloadPriceSnapshotStore implements PriceSnapshotStore {
  constructor(private readonly payload: Payload) {}

  async findLatest(input: {
    ruleKey: string
    ruleVersion: PricingRule['version']
    tld: string
  }): Promise<StoredPriceSnapshot | undefined> {
    const result = await this.payload.find({
      collection: 'priceSnapshots',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      sort: '-providerObservedAt',
      where: {
        and: [
          { tld: { equals: input.tld } },
          { ruleKey: { equals: input.ruleKey } },
          { ruleVersion: { equals: input.ruleVersion } },
          { schemaVersion: { equals: PRICE_SNAPSHOT_SCHEMA_VERSION } },
          { calculationVersion: { equals: PRICE_CALCULATION_VERSION } },
        ],
      },
    })
    const doc = result.docs[0]
    return doc ? fromDocument(doc) : undefined
  }

  async record(input: PriceSnapshotInput): Promise<StoredPriceSnapshot> {
    const calculationHash = createPriceCalculationHash(input)
    const existing = await this.findByHash(calculationHash)
    if (existing) return existing

    const rule = input.calculation.rule
    try {
      const created = await this.payload.create({
        collection: 'priceSnapshots',
        data: {
          calculationFormula: input.calculation.calculationFormula,
          calculationHash,
          calculationVersion: PRICE_CALCULATION_VERSION,
          createdTraceId: input.traceId,
          currency: 'CNY',
          oneYearTotalMinor: input.calculation.oneYearTotalFen,
          priceClass: 'standard',
          provider: 'westdigital_fixture',
          ...(input.providerCacheExpiresAt
            ? { providerCacheExpiresAt: input.providerCacheExpiresAt }
            : {}),
          providerCacheStatus: input.providerCacheStatus,
          providerObservedAt: input.providerObservedAt,
          providerProductId: input.providerProductId,
          providerRequestId: input.providerRequestId,
          registrationPriceMinor: input.calculation.registrationPriceFen,
          representativeDomainAscii: input.representativeDomainAscii,
          renewalPriceMinor: input.calculation.renewalPriceFen,
          ...(rule.mode === 'fixed'
            ? { ruleFixedAmountMinor: rule.fixedAmountFen }
            : { rulePercentageBasisPoints: rule.percentageBasisPoints }),
          ruleKey: rule.key,
          ruleMode: rule.mode,
          ruleSource: rule.source,
          ruleVersion: rule.version,
          roundingMode: 'half_up_to_fen',
          schemaVersion: PRICE_SNAPSHOT_SCHEMA_VERSION,
          snapshotRef: randomUUID(),
          threeYearTotalMinor: input.calculation.threeYearTotalFen,
          tld: input.tld,
          upstreamRegistrationPriceMinor: input.calculation.upstreamRegistrationPriceFen,
          upstreamRenewalPriceMinor: input.calculation.upstreamRenewalPriceFen,
        },
        overrideAccess: true,
      })
      return fromDocument(created)
    } catch (error) {
      const concurrent = await this.findByHash(calculationHash)
      if (concurrent) return concurrent
      throw error
    }
  }

  private async findByHash(calculationHash: string): Promise<StoredPriceSnapshot | undefined> {
    const result = await this.payload.find({
      collection: 'priceSnapshots',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { calculationHash: { equals: calculationHash } },
    })
    const doc = result.docs[0]
    return doc ? fromDocument(doc) : undefined
  }
}

export function replayPriceSnapshot(snapshot: StoredPriceSnapshot): PriceCalculation {
  const replay = calculateTldPrice({
    registrationPriceFen: snapshot.calculation.upstreamRegistrationPriceFen,
    renewalPriceFen: snapshot.calculation.upstreamRenewalPriceFen,
    rule: snapshot.calculation.rule,
  })
  if (JSON.stringify(replay) !== JSON.stringify(snapshot.calculation)) {
    throw new AppError('PRICE_SNAPSHOT_REPLAY_MISMATCH', '价格快照无法复现原始计算结果', 500, {
      action: '请联系系统管理员检查价格快照',
      retryable: false,
      title: '价格快照校验失败',
    })
  }
  return replay
}
