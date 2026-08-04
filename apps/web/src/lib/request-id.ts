export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/

export function isValidTraceId(value: null | string | undefined): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
}

export function createTraceId(): string {
  return globalThis.crypto.randomUUID()
}

export function getTraceId(headers?: Pick<Headers, 'get'>): string {
  const supplied = headers?.get('x-request-id')
  return isValidTraceId(supplied) ? supplied : createTraceId()
}
