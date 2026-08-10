import { createHash, randomBytes } from 'node:crypto'
import OSS from 'ali-oss'

import { getEnv } from '@/lib/env'
import type { RealnameObjectProvider } from './types'
import { mockFailure, mockSuccess } from './mock'

const objects = new Map<string, Uint8Array>()

function liveRealnameOssAllowed(): boolean {
  const env = getEnv()
  return env.ALLOW_REAL_PROVIDER_WRITES && env.ALLOW_REAL_ALIYUN_OSS_REALNAME
}

export class MockRealnameObjectProvider implements RealnameObjectProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async upload(input: { body: Uint8Array; key: string; traceId: string }) {
    objects.set(input.key, input.body)
    return mockSuccess({ etag: createHash('sha256').update(input.body).digest('hex') })
  }

  async signRead(input: { expiresSeconds: number; key: string; traceId: string }) {
    if (!objects.has(input.key)) throw new Error('Mock object not found')
    const opaqueId = createHash('sha256')
      .update(input.key)
      .update(randomBytes(16))
      .digest('base64url')
    return mockSuccess({
      url: `mock-oss://private/${opaqueId}?ttl=${input.expiresSeconds}`,
    })
  }

  async read(input: { key: string; traceId: string }) {
    const body = objects.get(input.key)
    if (!body) return mockFailure('OSS_OBJECT_NOT_FOUND', { statusKnown: true })
    return mockSuccess({ body, etag: createHash('sha256').update(body).digest('hex') })
  }

  async deleteObject(input: { key: string; traceId: string }) {
    objects.delete(input.key)
    return mockSuccess({ deleted: true as const })
  }
}

class DisabledRealnameObjectProvider implements RealnameObjectProvider {
  async health() {
    return mockSuccess({ healthy: false })
  }

  async upload(_input: { body: Uint8Array; key: string; traceId: string }) {
    void _input.body
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async read(_input: { key: string; traceId: string }) {
    void _input.key
    void _input.traceId
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async signRead(_input: { expiresSeconds: number; key: string; traceId: string }) {
    void _input.expiresSeconds
    void _input.key
    void _input.traceId
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async deleteObject(_input: { key: string; traceId: string }) {
    void _input.key
    void _input.traceId
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }
}

type AliOssClient = Pick<OSS, 'delete' | 'get' | 'put' | 'signatureUrl'>

export class AliOssRealnameProvider implements RealnameObjectProvider {
  constructor(
    private readonly client: AliOssClient,
    private readonly allowedPrefix?: string,
  ) {}

  private keyAllowed(key: string): boolean {
    return !this.allowedPrefix || key.startsWith(`${this.allowedPrefix}/`)
  }

  async health() {
    return mockSuccess({ healthy: true })
  }

  async upload(input: { body: Uint8Array; key: string; traceId: string }) {
    if (!this.keyAllowed(input.key)) {
      return mockFailure('OSS_KEY_OUT_OF_SCOPE', { statusKnown: true })
    }
    if (!liveRealnameOssAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const result = await this.client.put(input.key, Buffer.from(input.body))
      const headers = result.res.headers as Record<string, unknown>
      return mockSuccess({ etag: String(headers.etag ?? '').replaceAll('"', '') })
    } catch {
      return mockFailure('OSS_UPLOAD_FAILED', { retryable: true, statusKnown: false })
    }
  }

  async read(input: { key: string; traceId: string }) {
    if (!this.keyAllowed(input.key)) {
      return mockFailure('OSS_KEY_OUT_OF_SCOPE', { statusKnown: true })
    }
    if (!liveRealnameOssAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const result = await this.client.get(input.key)
      const body = new Uint8Array(result.content)
      const headers = result.res.headers as Record<string, unknown>
      return mockSuccess({
        body,
        etag: String(headers.etag ?? createHash('sha256').update(body).digest('hex')).replaceAll(
          '"',
          '',
        ),
      })
    } catch {
      return mockFailure('OSS_READ_FAILED', { retryable: true, statusKnown: true })
    }
  }

  async signRead(input: { expiresSeconds: number; key: string; traceId: string }) {
    if (!this.keyAllowed(input.key) || input.expiresSeconds < 1 || input.expiresSeconds > 120) {
      return mockFailure('OSS_SIGN_SCOPE_INVALID', { statusKnown: true })
    }
    if (!liveRealnameOssAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      return mockSuccess({
        url: this.client.signatureUrl(input.key, { expires: input.expiresSeconds }),
      })
    } catch {
      return mockFailure('OSS_SIGN_FAILED', { statusKnown: true })
    }
  }

  async deleteObject(input: { key: string; traceId: string }) {
    if (!this.keyAllowed(input.key)) {
      return mockFailure('OSS_KEY_OUT_OF_SCOPE', { statusKnown: true })
    }
    if (!liveRealnameOssAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      await this.client.delete(input.key)
      return mockSuccess({ deleted: true as const })
    } catch {
      return mockFailure('OSS_DELETE_FAILED', { retryable: true, statusKnown: false })
    }
  }
}

export function createRealnameObjectProvider(): RealnameObjectProvider {
  const env = getEnv()
  if (env.ALIYUN_OSS_REALNAME_MODE === 'mock') return new MockRealnameObjectProvider()
  if (!liveRealnameOssAllowed()) return new DisabledRealnameObjectProvider()
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  const bucket = env.OSS_REALNAME_BUCKET
  const endpoint = env.OSS_REALNAME_ENDPOINT
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) {
    throw new Error('Private OSS live mode is missing explicit credentials, bucket, or endpoint')
  }
  if (bucket === env.S3_BUCKET) {
    throw new Error('Private real-name OSS bucket must not reuse the public media bucket')
  }
  return new AliOssRealnameProvider(
    new OSS({ accessKeyId, accessKeySecret, bucket, endpoint, secure: true }),
    env.OSS_REALNAME_PREFIX,
  )
}
