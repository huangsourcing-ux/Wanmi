import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import KmsClient, { DecryptRequest, GenerateDataKeyRequest } from '@alicloud/kms20160120'
import { $OpenApiUtil } from '@alicloud/openapi-core'

import { getEnv } from '@/lib/env'
import type { KmsProvider } from './types'
import { mockFailure, mockSuccess } from './mock'

const mockKeyEncryptionKey = randomBytes(32)

function liveKmsAllowed(): boolean {
  const env = getEnv()
  return env.ALLOW_REAL_PROVIDER_WRITES && env.ALLOW_REAL_ALIYUN_KMS
}

export class MockKmsProvider implements KmsProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async generateDataKey(_input: { traceId: string }) {
    void _input.traceId
    const plaintext = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', mockKeyEncryptionKey, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return mockSuccess({
      ciphertext: [
        'mock-v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url'),
      ].join('.'),
      plaintext,
    })
  }

  async decryptDataKey(input: { ciphertext: string; traceId: string }) {
    void input.traceId
    try {
      const [version, encodedIv, encodedTag, encodedCiphertext] = input.ciphertext.split('.')
      if (version !== 'mock-v1' || !encodedIv || !encodedTag || !encodedCiphertext) {
        return mockFailure('KMS_INVALID_CIPHERTEXT', { statusKnown: true })
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        mockKeyEncryptionKey,
        Buffer.from(encodedIv, 'base64url'),
      )
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
      return mockSuccess({
        plaintext: Buffer.concat([
          decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
          decipher.final(),
        ]),
      })
    } catch {
      return mockFailure('KMS_INVALID_CIPHERTEXT', { statusKnown: true })
    }
  }
}

class DisabledKmsProvider implements KmsProvider {
  async health() {
    return mockSuccess({ healthy: false })
  }

  async generateDataKey(_input: { traceId: string }) {
    void _input.traceId
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async decryptDataKey(_input: { ciphertext: string; traceId: string }) {
    void _input.ciphertext
    void _input.traceId
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }
}

export class AlibabaKmsProvider implements KmsProvider {
  private readonly client: KmsClient

  constructor() {
    this.client = new KmsClient(
      new $OpenApiUtil.Config({
        accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
        connectTimeout: 2_000,
        endpoint: process.env.ALIBABA_CLOUD_KMS_ENDPOINT,
        readTimeout: 3_000,
        regionId: process.env.ALIBABA_CLOUD_REGION_ID,
      }),
    )
  }

  async health() {
    return mockSuccess({
      healthy: Boolean(
        process.env.ALIBABA_CLOUD_ACCESS_KEY_ID &&
          process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET &&
          process.env.ALIBABA_CLOUD_REGION_ID &&
          process.env.KMS_KEY_ID,
      ),
    })
  }

  async generateDataKey(_input: { traceId: string }) {
    void _input.traceId
    if (!liveKmsAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const result = await this.client.generateDataKey(
        new GenerateDataKeyRequest({ keyId: process.env.KMS_KEY_ID, keySpec: 'AES_256' }),
      )
      if (!result.body?.ciphertextBlob || !result.body.plaintext) {
        return mockFailure('KMS_INVALID_RESPONSE', { statusKnown: true })
      }
      return mockSuccess({
        ciphertext: result.body.ciphertextBlob,
        plaintext: Buffer.from(result.body.plaintext, 'base64'),
      })
    } catch {
      return mockFailure('KMS_UNAVAILABLE', { retryable: true, statusKnown: false })
    }
  }

  async decryptDataKey(input: { ciphertext: string; traceId: string }) {
    if (!liveKmsAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const result = await this.client.decrypt(
        new DecryptRequest({ ciphertextBlob: input.ciphertext }),
      )
      if (!result.body?.plaintext) return mockFailure('KMS_INVALID_RESPONSE', { statusKnown: true })
      return mockSuccess({ plaintext: Buffer.from(result.body.plaintext, 'base64') })
    } catch {
      return mockFailure('KMS_UNAVAILABLE', { retryable: true, statusKnown: false })
    }
  }
}

export function createKmsProvider(): KmsProvider {
  const env = getEnv()
  if (env.ALIYUN_KMS_MODE !== 'live') return new MockKmsProvider()
  if (!liveKmsAllowed()) return new DisabledKmsProvider()
  if (
    !process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ||
    !process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ||
    !process.env.ALIBABA_CLOUD_REGION_ID ||
    !process.env.KMS_KEY_ID
  ) {
    throw new Error('KMS live mode is missing explicit credentials, region, or key reference')
  }
  return new AlibabaKmsProvider()
}
