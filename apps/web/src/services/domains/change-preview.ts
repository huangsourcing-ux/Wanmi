import { hmac, safeEqualHex } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'

type PreviewError = { code: string; message: string }

export function signBoundChangePreview(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${hmac(encoded, getEnv().SESSION_PEPPER)}`
}

export function decodeBoundChangePreview(token: string, error: PreviewError): unknown {
  const [encoded = '', signature = '', extra] = token.split('.')
  if (
    extra ||
    !/^[a-f0-9]{64}$/iu.test(signature) ||
    !safeEqualHex(hmac(encoded, getEnv().SESSION_PEPPER), signature)
  ) {
    throw new AppError(error.code, error.message, 409)
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new AppError(error.code, error.message, 409)
  }
}
