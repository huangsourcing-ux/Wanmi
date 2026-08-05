import { toASCII, toUnicode, type Options as Tr46Options } from 'tr46'
import { isMixedScript, unicodeScript, unicodeScripts } from 'unicode-script'

import { AppError, toProblemDetails } from '@/lib/errors'
import { IDNA2008_ALLOWED_RANGES, type Idna2008Category } from '@/lib/idna2008-ranges'
import type { Result } from '@/schemas/api'

export const DOMAIN_ERROR_CODES = [
  'DOMAIN_EMPTY',
  'DOMAIN_EMPTY_LABEL',
  'DOMAIN_INVALID_CHARACTER',
  'DOMAIN_INVALID_HYPHEN',
  'DOMAIN_INVALID_PUNYCODE',
  'DOMAIN_LABEL_TOO_LONG',
  'DOMAIN_NAME_TOO_LONG',
  'DOMAIN_NUMERIC_TLD',
  'DOMAIN_IDNA_INVALID',
] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

export type DomainValidationError = {
  code: DomainErrorCode
  message: string
}

export type DomainRiskWarning = {
  code: 'DOMAIN_MIXED_SCRIPT_RISK'
  labelAscii: string
  message: string
  scripts: string[]
}

export type NormalizedDomain = {
  ascii: string
  display: string
  risks: DomainRiskWarning[]
  unicode: string
}

export type DomainNormalizationResult =
  | { ok: false; error: DomainValidationError }
  | { ok: true; value: NormalizedDomain }

const DOT_SEPARATOR_PATTERN = /[.\u3002\uFF0E\uFF61]/gu
const ROOT_DOT_PATTERN = /[.\u3002\uFF0E\uFF61]$/u
const ASCII_LABEL_PATTERN = /^[a-z0-9-]+$/u
const NUMERIC_LABEL_PATTERN = /^\d+$/u
const UNICODE_NUMERIC_LABEL_PATTERN = /^\p{Decimal_Number}+$/u
const NON_ASCII_PATTERN = /[^\x00-\x7F]/u
const OBVIOUS_INVALID_CHARACTER_PATTERN =
  /[^\p{Letter}\p{Mark}\p{Number}.\-\u00B7\u0375\u05F3\u05F4\u200C\u200D\u30FB]/u

const TR46_OPTIONS = {
  checkBidi: true,
  checkHyphens: true,
  checkJoiners: true,
  ignoreInvalidPunycode: false,
  transitionalProcessing: false,
  useSTD3ASCIIRules: true,
} satisfies Tr46Options

const ERROR_MESSAGES: Record<DomainErrorCode, string> = {
  DOMAIN_EMPTY: '请输入域名',
  DOMAIN_EMPTY_LABEL: '域名包含空标签',
  DOMAIN_IDNA_INVALID: '域名不符合 IDNA2008 规则',
  DOMAIN_INVALID_CHARACTER: '域名包含不受支持的字符',
  DOMAIN_INVALID_HYPHEN: '域名标签的连字符位置无效',
  DOMAIN_INVALID_PUNYCODE: 'Punycode 标签无效',
  DOMAIN_LABEL_TOO_LONG: '域名标签超过 63 个 ASCII 字节',
  DOMAIN_NAME_TOO_LONG: '域名超过 253 个 ASCII 字节',
  DOMAIN_NUMERIC_TLD: '顶级域不能全部为数字',
}

function failure(code: DomainErrorCode): DomainNormalizationResult {
  return { error: { code, message: ERROR_MESSAGES[code] }, ok: false }
}

function idna2008Category(codePoint: number): Idna2008Category | undefined {
  let lower = 0
  let upper = IDNA2008_ALLOWED_RANGES.length - 1

  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const [start, end, category] = IDNA2008_ALLOWED_RANGES[middle]
    if (codePoint < start) upper = middle - 1
    else if (codePoint > end) lower = middle + 1
    else return category
  }

  return undefined
}

function hasInvalidContextO(label: string, characters: string[], index: number): boolean {
  const codePoint = characters[index].codePointAt(0)
  if (codePoint === undefined) return true

  if (codePoint === 0x00b7) return characters[index - 1] !== 'l' || characters[index + 1] !== 'l'
  if (codePoint === 0x0375) return unicodeScript(characters[index + 1] ?? '') !== 'Greek'
  if (codePoint === 0x05f3 || codePoint === 0x05f4)
    return unicodeScript(characters[index - 1] ?? '') !== 'Hebrew'
  if (codePoint >= 0x0660 && codePoint <= 0x0669) return /[\u06F0-\u06F9]/u.test(label)
  if (codePoint >= 0x06f0 && codePoint <= 0x06f9) return /[\u0660-\u0669]/u.test(label)
  if (codePoint === 0x30fb) {
    const scripts = unicodeScripts(label)
    return !['Han', 'Hiragana', 'Katakana'].some((script) => scripts.has(script))
  }

  return true
}

type Idna2008LabelStatus = 'invalid-character' | 'invalid-context' | 'valid'

function validateIdna2008Label(label: string): Idna2008LabelStatus {
  const characters = [...label]

  for (const [index, character] of characters.entries()) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) return 'invalid-character'
    const category = idna2008Category(codePoint)
    if (!category) return 'invalid-character'
    if (category === 'CONTEXTO' && hasInvalidContextO(label, characters, index))
      return 'invalid-context'
    // CONTEXTJ is already validated by tr46 with checkJoiners enabled.
  }

  return 'valid'
}

function inspectInputLabels(candidate: string): DomainNormalizationResult | string[] {
  const inspectionValue = candidate
    .normalize('NFKC')
    .toLowerCase()
    .replace(DOT_SEPARATOR_PATTERN, '.')
  const labels = inspectionValue.split('.')

  if (labels.some((label) => label.length === 0)) return failure('DOMAIN_EMPTY_LABEL')

  for (const label of labels) {
    const isALabel = label.startsWith('xn--')
    if (isALabel) {
      if (label.startsWith('xn--xn--') || NON_ASCII_PATTERN.test(label))
        return failure('DOMAIN_INVALID_PUNYCODE')
      continue
    }

    if (label.startsWith('-') || label.endsWith('-') || (label[2] === '-' && label[3] === '-'))
      return failure('DOMAIN_INVALID_HYPHEN')
  }

  if (UNICODE_NUMERIC_LABEL_PATTERN.test(labels.at(-1) ?? '')) return failure('DOMAIN_NUMERIC_TLD')

  return labels
}

function createRiskWarnings(unicodeLabels: string[], asciiLabels: string[]): DomainRiskWarning[] {
  const risks: DomainRiskWarning[] = []

  for (const [index, label] of unicodeLabels.entries()) {
    if (!isMixedScript(label)) continue
    const scripts = [...unicodeScripts(label)].filter(
      (script) => script !== 'Common' && script !== 'Inherited' && script !== 'Unknown',
    )
    risks.push({
      code: 'DOMAIN_MIXED_SCRIPT_RISK',
      labelAscii: asciiLabels[index],
      message: '该标签混合多种书写系统，可能存在同形异义风险；转换成功不代表可注册或商标安全。',
      scripts,
    })
  }

  return risks
}

export function normalizeDomain(input: string): DomainNormalizationResult {
  let candidate = input.trim()
  if (candidate.length === 0) return failure('DOMAIN_EMPTY')

  if (ROOT_DOT_PATTERN.test(candidate)) candidate = candidate.slice(0, -1)
  if (candidate.length === 0) return failure('DOMAIN_EMPTY')

  const inspectedLabels = inspectInputLabels(candidate)
  if (!Array.isArray(inspectedLabels)) return inspectedLabels

  const ascii = toASCII(candidate, { ...TR46_OPTIONS, verifyDNSLength: false })
  if (ascii === null) {
    if (inspectedLabels.some((label) => label.startsWith('xn--')))
      return failure('DOMAIN_INVALID_PUNYCODE')
    if (OBVIOUS_INVALID_CHARACTER_PATTERN.test(inspectedLabels.join('.')))
      return failure('DOMAIN_INVALID_CHARACTER')
    return failure('DOMAIN_IDNA_INVALID')
  }

  const asciiLabels = ascii.split('.')
  if (asciiLabels.some((label) => label.length === 0)) return failure('DOMAIN_EMPTY_LABEL')
  if (asciiLabels.some((label) => !ASCII_LABEL_PATTERN.test(label)))
    return failure('DOMAIN_INVALID_CHARACTER')

  const unicodeResult = toUnicode(ascii, TR46_OPTIONS)
  if (unicodeResult.error) return failure('DOMAIN_INVALID_PUNYCODE')
  const unicodeLabels = unicodeResult.domain.split('.')
  if (unicodeLabels.length !== asciiLabels.length) return failure('DOMAIN_INVALID_PUNYCODE')
  const idna2008Statuses = unicodeLabels.map(validateIdna2008Label)
  if (idna2008Statuses.includes('invalid-character')) return failure('DOMAIN_INVALID_CHARACTER')
  if (idna2008Statuses.includes('invalid-context')) return failure('DOMAIN_IDNA_INVALID')

  const roundTrip = toASCII(unicodeResult.domain, { ...TR46_OPTIONS, verifyDNSLength: false })
  if (roundTrip !== ascii) return failure('DOMAIN_INVALID_PUNYCODE')

  if (asciiLabels.some((label) => label.length > 63)) return failure('DOMAIN_LABEL_TOO_LONG')
  if (ascii.length > 253) return failure('DOMAIN_NAME_TOO_LONG')
  if (
    NUMERIC_LABEL_PATTERN.test(asciiLabels.at(-1) ?? '') ||
    UNICODE_NUMERIC_LABEL_PATTERN.test(unicodeLabels.at(-1) ?? '')
  )
    return failure('DOMAIN_NUMERIC_TLD')

  return {
    ok: true,
    value: {
      ascii,
      display: ascii,
      risks: createRiskWarnings(unicodeLabels, asciiLabels),
      unicode: unicodeResult.domain,
    },
  }
}

export function normalizeDomainResult(input: string, traceId: string): Result<NormalizedDomain> {
  const result = normalizeDomain(input)
  if (result.ok) return { data: result.value, state: 'ready' }

  const problem = toProblemDetails(
    new AppError(result.error.code, result.error.message, 400, {
      action: '请检查域名格式后重试',
      retryable: false,
      title: '域名格式无效',
    }),
    traceId,
  )
  return { problem, state: 'error' }
}
