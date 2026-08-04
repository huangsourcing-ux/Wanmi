import { createHash } from 'node:crypto'
import OSS from 'ali-oss'

import { getEnv } from '@/lib/env'
import type { RealnameObjectProvider } from './types'
import { mockFailure, mockSuccess } from './mock'

const objects = new Map<string, Uint8Array>()

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
    return mockSuccess({
      url: `mock-oss://private/${encodeURIComponent(input.key)}?ttl=${input.expiresSeconds}`,
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

type AliOssClient = Pick<OSS, 'delete' | 'get' | 'put' | 'signatureUrl'>

export class AliOssRealnameProvider implements RealnameObjectProvider {
  constructor(private readonly client: AliOssClient) {}

  async health() {
    return mockSuccess({ healthy: true })
  }

  async upload(input: { body: Uint8Array; key: string; traceId: string }) {
    try {
      const result = await this.client.put(input.key, Buffer.from(input.body))
      const headers = result.res.headers as Record<string, unknown>
      return mockSuccess({ etag: String(headers.etag ?? '').replaceAll('"', '') })
    } catch {
      return mockFailure('OSS_UPLOAD_FAILED', { retryable: true, statusKnown: false })
    }
  }

  async read(input: { key: string; traceId: string }) {
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
    try {
      return mockSuccess({
        url: this.client.signatureUrl(input.key, { expires: input.expiresSeconds }),
      })
    } catch {
      return mockFailure('OSS_SIGN_FAILED', { statusKnown: true })
    }
  }

  async deleteObject(input: { key: string; traceId: string }) {
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
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  const bucket = process.env.OSS_REALNAME_BUCKET
  const endpoint = process.env.OSS_REALNAME_ENDPOINT
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) {
    throw new Error('Private OSS live mode is missing explicit credentials, bucket, or endpoint')
  }
  return new AliOssRealnameProvider(
    new OSS({ accessKeyId, accessKeySecret, bucket, endpoint, secure: true }),
  )
}
