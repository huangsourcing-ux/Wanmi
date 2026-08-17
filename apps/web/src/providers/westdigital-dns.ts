import type { WestDigitalDnsLineCode, WestDigitalDnsLineLabel } from '@/schemas/dns-management'

const DNS_LINE_CN_TO_CODE = {
  SEO: 'LSEO',
  境外: 'LFOR',
  搜索引擎: 'LSEO',
  教育: 'LEDU',
  教育网: 'LEDU',
  默认: '',
  电信: 'LTEL',
  移动: 'LMOB',
  联通: 'LCNC',
} as const satisfies Record<WestDigitalDnsLineLabel, WestDigitalDnsLineCode>

const DNS_LINE_CODE_TO_CN = {
  '': '默认',
  LCNC: '联通',
  LEDU: '教育网',
  LFOR: '境外',
  LMOB: '移动',
  LSEO: '搜索引擎',
  LTEL: '电信',
} as const satisfies Record<WestDigitalDnsLineCode, string>

export function westDigitalDnsLineCode(label: WestDigitalDnsLineLabel): WestDigitalDnsLineCode {
  return DNS_LINE_CN_TO_CODE[label]
}

export function westDigitalDnsLineLabel(code: WestDigitalDnsLineCode) {
  return DNS_LINE_CODE_TO_CN[code]
}
