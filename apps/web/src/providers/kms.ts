import { randomBytes } from 'node:crypto'
import KmsClient, { DecryptRequest, GenerateDataKeyRequest } from '@alicloud/kms20160120'
import { $OpenApiUtil } from '@alicloud/openapi-core'

import { getEnv } from '@/lib/env'
import type { KmsProvider } from './types'
import { mockFailure, mockSuccess } from './mock'

export class MockKmsProvider implements KmsProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async generateDataKey(_input: { traceId: string }) {
    void _input.traceId
    const plaintext = randomBytes(32)
    return mockSuccess({ ciphertext: `mock:${plaintext.toString('base64')}`, plaintext })
  }

  async decryptDataKey(input: { ciphertext: string; traceId: string }) {
    const encoded = input.ciphertext.replace(/^mock:/, '')
    return mockSuccess({ plaintext: Buffer.from(encoded, 'base64') })
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
    if (!getEnv().ALLOW_REAL_PROVIDER_WRITES) {
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
    if (!getEnv().ALLOW_REAL_PROVIDER_WRITES) {
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
  return getEnv().ALIYUN_KMS_MODE === 'live' ? new AlibabaKmsProvider() : new MockKmsProvider()
}
