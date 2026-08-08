import { createHash } from 'node:crypto'

import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeValidateHook,
  Payload,
  PayloadRequest,
} from 'payload'

import { normalizeDomain } from '@/lib/domain-name'
import type { PriceRule as PriceRuleDocument } from '@/payload-types'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import type { PricingRule } from '@/services/pricing/price-calculation'

type PriceRuleData = Partial<
  Pick<
    PriceRuleDocument,
    'effectiveAt' | 'enabled' | 'fixedAmountMinor' | 'mode' | 'percentageBasisPoints' | 'tld'
  >
>

const PRICE_RULE_AUDIT_SKIP_CONTEXT = 'skipPriceRuleAudit'

function invalid(message: string): never {
  throw new Error(message)
}

export function normalizePriceRuleTld(value: unknown): string {
  if (typeof value !== 'string') invalid('TLD 必须是字符串')
  const candidate = value.trim().replace(/^\./u, '')
  if (!candidate) invalid('TLD 不能为空')
  const normalized = normalizeDomain(`wanmi.${candidate}`)
  if (!normalized.ok) invalid('TLD 格式无效')
  return normalized.value.ascii.slice('wanmi.'.length)
}

function optionalNonNegativeSafeInteger(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`${label}必须是非负安全整数`)
  }
  return Number(value)
}

export function validatePriceRuleData(data: PriceRuleData): void {
  normalizePriceRuleTld(data.tld)
  const fixedAmountMinor = optionalNonNegativeSafeInteger(data.fixedAmountMinor, '固定加价金额')
  const percentageBasisPoints = optionalNonNegativeSafeInteger(
    data.percentageBasisPoints,
    '比例加价基点',
  )
  if (data.mode === 'fixed') {
    if (fixedAmountMinor === undefined) invalid('固定加价规则必须配置整数分金额')
    if (percentageBasisPoints !== undefined) invalid('固定加价规则不能配置比例基点')
    return
  }
  if (data.mode === 'percentage') {
    if (percentageBasisPoints === undefined) invalid('比例加价规则必须配置整数基点')
    if (fixedAmountMinor !== undefined) invalid('比例加价规则不能配置固定金额')
    return
  }
  invalid('加价规则模式无效')
}

export const validatePriceRuleWrite: CollectionBeforeValidateHook = ({
  data,
  operation,
  originalDoc,
}) => {
  const merged = {
    ...(operation === 'update' ? originalDoc : {}),
    ...data,
  } as PriceRuleData
  merged.tld = normalizePriceRuleTld(merged.tld)
  validatePriceRuleData(merged)
  return { ...data, tld: merged.tld }
}

export const stampPriceRuleEffectiveAt: CollectionBeforeChangeHook = ({ data }) => ({
  ...data,
  effectiveAt: new Date().toISOString(),
})

function auditSnapshot(doc: PriceRuleDocument | undefined) {
  if (!doc) return null
  return {
    enabled: doc.enabled,
    fixedAmountMinor: doc.fixedAmountMinor ?? null,
    mode: doc.mode,
    percentageBasisPoints: doc.percentageBasisPoints ?? null,
    tld: doc.tld,
  }
}

export const auditPriceRuleChange: CollectionAfterChangeHook = async ({
  context,
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (context[PRICE_RULE_AUDIT_SKIP_CONTEXT]) return doc
  const before = operation === 'update' ? auditSnapshot(previousDoc as PriceRuleDocument) : null
  const after = auditSnapshot(doc as PriceRuleDocument)
  const action =
    operation === 'create'
      ? 'pricing.rule.created'
      : !previousDoc?.enabled && doc.enabled
        ? 'pricing.rule.enabled'
        : previousDoc?.enabled && !doc.enabled
          ? 'pricing.rule.disabled'
          : 'pricing.rule.updated'
  await recordAuditEvent(req, {
    action,
    metadata: { after, before, effectiveAt: doc.effectiveAt },
    targetId: doc.id,
  })
  return doc
}

export const auditPriceRuleDelete: CollectionAfterDeleteHook = async ({ context, doc, req }) => {
  if (context[PRICE_RULE_AUDIT_SKIP_CONTEXT]) return doc
  await recordAuditEvent(req, {
    action: 'pricing.rule.deleted',
    metadata: {
      after: null,
      before: auditSnapshot(doc as PriceRuleDocument),
      effectiveAt: new Date().toISOString(),
    },
    targetId: doc.id,
  })
  return doc
}

function pricingRuleKey(doc: PriceRuleDocument): string {
  return `price-rule-${doc.id}-${createHash('sha256')
    .update(
      JSON.stringify({
        effectiveAt: doc.effectiveAt,
        fixedAmountMinor: doc.fixedAmountMinor ?? null,
        mode: doc.mode,
        percentageBasisPoints: doc.percentageBasisPoints ?? null,
        tld: doc.tld,
      }),
    )
    .digest('hex')}`
}

export function pricingRuleFromDocument(doc: PriceRuleDocument): PricingRule {
  validatePriceRuleData(doc)
  const base = {
    key: pricingRuleKey(doc),
    source: 'price_rule_collection' as const,
    tld: doc.tld,
    version: 1 as const,
  }
  return doc.mode === 'fixed'
    ? { ...base, fixedAmountFen: doc.fixedAmountMinor as number, mode: 'fixed' }
    : {
        ...base,
        mode: 'percentage',
        percentageBasisPoints: doc.percentageBasisPoints as number,
      }
}

export async function loadEnabledPricingRules(
  payload: Payload,
  req?: PayloadRequest,
): Promise<Readonly<Record<string, PricingRule>>> {
  const result = await payload.find({
    collection: 'priceRules',
    depth: 0,
    limit: 1_000,
    overrideAccess: true,
    ...(req ? { req } : {}),
    where: { enabled: { equals: true } },
  })
  return Object.freeze(
    Object.fromEntries(result.docs.map((doc) => [doc.tld, pricingRuleFromDocument(doc)])),
  )
}
