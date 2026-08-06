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
  labelPosition?: number
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

const LABEL_ERROR_MESSAGES: Partial<Record<DomainErrorCode, string>> = {
  DOMAIN_EMPTY_LABEL: '为空',
  DOMAIN_IDNA_INVALID: '不符合 IDNA2008 上下文或双向文本规则',
  DOMAIN_INVALID_CHARACTER: '包含不受支持的字符',
  DOMAIN_INVALID_HYPHEN: '的连字符位置无效',
  DOMAIN_INVALID_PUNYCODE: '不是有效的 Punycode',
  DOMAIN_LABEL_TOO_LONG: '转换后超过 63 个 ASCII 字节',
  DOMAIN_NUMERIC_TLD: '是顶级域，不能全部为数字',
}

const SCRIPT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  Arabic: '阿拉伯文',
  Armenian: '亚美尼亚文',
  Bengali: '孟加拉文',
  Cyrillic: '西里尔文',
  Devanagari: '天城文',
  Georgian: '格鲁吉亚文',
  Greek: '希腊文',
  Gujarati: '古吉拉特文',
  Gurmukhi: '古木基文',
  Han: '汉字',
  Hangul: '韩文',
  Hebrew: '希伯来文',
  Hiragana: '平假名',
  Kannada: '卡纳达文',
  Katakana: '片假名',
  Latin: '拉丁文',
  Malayalam: '马拉雅拉姆文',
  Oriya: '奥里亚文',
  Tamil: '泰米尔文',
  Telugu: '泰卢固文',
  Thai: '泰文',
}

export function formatUnicodeScriptName(script: string): string {
  const canonicalName = script.replaceAll('_', ' ')
  const localizedName = SCRIPT_DISPLAY_NAMES[script]
  return localizedName ? `${localizedName}（${canonicalName}）` : canonicalName
}

function failure(code: DomainErrorCode, labelIndex?: number): DomainNormalizationResult {
  const labelPosition = labelIndex === undefined ? undefined : labelIndex + 1
  const labelMessage = LABEL_ERROR_MESSAGES[code]
  const message =
    labelPosition !== undefined && labelMessage
      ? `第 ${labelPosition} 个标签${labelMessage}`
      : ERROR_MESSAGES[code]
  return {
    error: {
      code,
      ...(labelPosition === undefined ? {} : { labelPosition }),
      message,
    },
    ok: false,
  }
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

  const emptyLabelIndex = labels.findIndex((label) => label.length === 0)
  if (emptyLabelIndex >= 0) return failure('DOMAIN_EMPTY_LABEL', emptyLabelIndex)

  for (const [index, label] of labels.entries()) {
    const isALabel = label.startsWith('xn--')
    if (isALabel) {
      if (label.startsWith('xn--xn--') || NON_ASCII_PATTERN.test(label))
        return failure('DOMAIN_INVALID_PUNYCODE', index)
      continue
    }

    if (label.startsWith('-') || label.endsWith('-') || (label[2] === '-' && label[3] === '-'))
      return failure('DOMAIN_INVALID_HYPHEN', index)
  }

  if (UNICODE_NUMERIC_LABEL_PATTERN.test(labels.at(-1) ?? ''))
    return failure('DOMAIN_NUMERIC_TLD', labels.length - 1)

  return labels
}

function createRiskWarnings(unicodeLabels: string[], asciiLabels: string[]): DomainRiskWarning[] {
  const risks: DomainRiskWarning[] = []

  for (const [index, label] of unicodeLabels.entries()) {
    if (!isMixedScript(label)) continue
    const scripts = [...unicodeScripts(label)].filter(
      (script) => script !== 'Common' && script !== 'Inherited' && script !== 'Unknown',
    )
    const scriptNames = scripts.map(formatUnicodeScriptName).join('、')
    risks.push({
      code: 'DOMAIN_MIXED_SCRIPT_RISK',
      labelAscii: asciiLabels[index],
      message: `标签“${asciiLabels[index]}”混合使用 ${scriptNames} 书写系统，可能存在同形异义风险；转换成功不代表可注册或商标安全。`,
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
    const invalidPunycodeIndex = inspectedLabels.findIndex(
      (label) =>
        label.startsWith('xn--') &&
        toASCII(label, { ...TR46_OPTIONS, verifyDNSLength: false }) === null,
    )
    if (invalidPunycodeIndex >= 0) return failure('DOMAIN_INVALID_PUNYCODE', invalidPunycodeIndex)
    const invalidCharacterIndex = inspectedLabels.findIndex((label) =>
      OBVIOUS_INVALID_CHARACTER_PATTERN.test(label),
    )
    if (invalidCharacterIndex >= 0)
      return failure('DOMAIN_INVALID_CHARACTER', invalidCharacterIndex)
    const invalidIdnaIndex = inspectedLabels.findIndex(
      (label) => toASCII(label, { ...TR46_OPTIONS, verifyDNSLength: false }) === null,
    )
    return failure('DOMAIN_IDNA_INVALID', invalidIdnaIndex >= 0 ? invalidIdnaIndex : undefined)
  }

  const asciiLabels = ascii.split('.')
  const emptyAsciiLabelIndex = asciiLabels.findIndex((label) => label.length === 0)
  if (emptyAsciiLabelIndex >= 0) return failure('DOMAIN_EMPTY_LABEL', emptyAsciiLabelIndex)
  const invalidAsciiLabelIndex = asciiLabels.findIndex((label) => !ASCII_LABEL_PATTERN.test(label))
  if (invalidAsciiLabelIndex >= 0)
    return failure('DOMAIN_INVALID_CHARACTER', invalidAsciiLabelIndex)

  const unicodeResult = toUnicode(ascii, TR46_OPTIONS)
  if (unicodeResult.error) {
    const invalidPunycodeIndex = asciiLabels.findIndex(
      (label) => toUnicode(label, TR46_OPTIONS).error,
    )
    return failure(
      'DOMAIN_INVALID_PUNYCODE',
      invalidPunycodeIndex >= 0 ? invalidPunycodeIndex : undefined,
    )
  }
  const unicodeLabels = unicodeResult.domain.split('.')
  if (unicodeLabels.length !== asciiLabels.length) return failure('DOMAIN_INVALID_PUNYCODE')
  const idna2008Statuses = unicodeLabels.map(validateIdna2008Label)
  const invalidCharacterIndex = idna2008Statuses.indexOf('invalid-character')
  if (invalidCharacterIndex >= 0) return failure('DOMAIN_INVALID_CHARACTER', invalidCharacterIndex)
  const invalidContextIndex = idna2008Statuses.indexOf('invalid-context')
  if (invalidContextIndex >= 0) return failure('DOMAIN_IDNA_INVALID', invalidContextIndex)

  const roundTrip = toASCII(unicodeResult.domain, { ...TR46_OPTIONS, verifyDNSLength: false })
  if (roundTrip !== ascii) {
    const roundTripLabels = roundTrip?.split('.') ?? []
    const invalidPunycodeIndex = asciiLabels.findIndex(
      (label, index) => roundTripLabels[index] !== label,
    )
    return failure(
      'DOMAIN_INVALID_PUNYCODE',
      invalidPunycodeIndex >= 0 ? invalidPunycodeIndex : undefined,
    )
  }

  const longLabelIndex = asciiLabels.findIndex((label) => label.length > 63)
  if (longLabelIndex >= 0) return failure('DOMAIN_LABEL_TOO_LONG', longLabelIndex)
  if (ascii.length > 253) return failure('DOMAIN_NAME_TOO_LONG')
  if (
    NUMERIC_LABEL_PATTERN.test(asciiLabels.at(-1) ?? '') ||
    UNICODE_NUMERIC_LABEL_PATTERN.test(unicodeLabels.at(-1) ?? '')
  )
    return failure('DOMAIN_NUMERIC_TLD', asciiLabels.length - 1)

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
