import { randomBytes, randomUUID } from 'node:crypto'

import OSS from 'ali-oss'
import sharp from 'sharp'

import { getEnv } from '../src/lib/env'
import {
  OssVersionRecoveryError,
  type OssVersionRecoveryClient,
  runOssVersionRecoveryDrill,
} from '../src/services/realname/oss-version-recovery'
import { validateRealnameFile } from '../src/services/realname/file-validation'
import { createRealnameDocumentMasterKeyring } from '../src/services/realname/master-key'

const acknowledgement = 'D7-09-OSS-DELETE-RECOVERY'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function preflight(): void {
  assert(
    process.env.RUN_REAL_OSS_DELETE_RECOVERY === acknowledgement,
    `RUN_REAL_OSS_DELETE_RECOVERY must equal ${acknowledgement}`,
  )
  assert(!/^(?:1|true)$/iu.test(process.env.CI ?? ''), 'Real OSS recovery is forbidden in CI')
  const env = getEnv()
  assert(env.ALLOW_REAL_PROVIDER_WRITES, 'Temporary live-provider gate must be enabled')
  assert(env.ALLOW_REAL_ALIYUN_OSS_REALNAME, 'Private OSS capability gate must be enabled')
  const forbidden = [
    env.ALLOW_REAL_ALIYUN_SMS_SENDS,
    env.ALLOW_REAL_WECHATPAY_PAYMENTS,
    env.ALLOW_REAL_WECHATPAY_REFUNDS,
    env.ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES,
    env.ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES,
    env.ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES,
    env.ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES,
  ]
  assert(
    forbidden.every((enabled) => !enabled),
    'A forbidden provider write gate is enabled',
  )
  assert(env.ALIYUN_OSS_REALNAME_MODE === 'live', 'Private OSS mode must be live')
}

async function main(): Promise<void> {
  preflight()
  const env = getEnv()
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  assert(accessKeyId && accessKeySecret, 'Private OSS credentials must be provided')
  assert(env.OSS_REALNAME_BUCKET && env.OSS_REALNAME_ENDPOINT, 'Private OSS location is required')

  const client = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket: env.OSS_REALNAME_BUCKET,
    endpoint: env.OSS_REALNAME_ENDPOINT,
    secure: true,
    timeout: 15_000,
  }) as OSS & OssVersionRecoveryClient
  const fixture = await sharp({
    create: {
      background: { alpha: 1, b: 0x30, g: 0x20, r: 0x10 },
      channels: 4,
      height: 64,
      width: 64,
    },
  })
    .png()
    .toBuffer()
  const validated = await validateRealnameFile(fixture, env.REALNAME_DOCUMENT_MAX_BYTES)
  const key = `${env.OSS_REALNAME_PREFIX}/recovery-drills/d7-09/${randomUUID()}-${randomBytes(16).toString('hex')}.wrn`
  try {
    const result = await runOssVersionRecoveryDrill({
      allowedPrefix: env.OSS_REALNAME_PREFIX,
      bucket: env.OSS_REALNAME_BUCKET,
      client,
      contentType: validated.contentType,
      key,
      keyring: createRealnameDocumentMasterKeyring(),
      plaintext: validated.body,
      sha256: validated.sha256,
    })
    process.stdout.write(
      `${JSON.stringify({
        acknowledgement,
        cleanupVerified: result.cleanupVerified,
        contentSha256: result.contentSha256,
        decryptedWithOriginalMasterKeyVersion: result.decryptedWithOriginalMasterKeyVersion,
        masterKeyVersion: result.masterKeyVersion,
        noncurrentRetentionDays: result.noncurrentRetentionDays,
        restoredCurrentVersion: result.restoredCurrentVersion,
        status: 'passed',
        versioningStatus: result.versioningStatus,
      })}\n`,
    )
  } finally {
    fixture.fill(0)
    validated.body.fill(0)
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      code: error instanceof OssVersionRecoveryError ? error.code : 'PREFLIGHT_OR_PROVIDER_FAILED',
      status: 'failed',
    })}\n`,
  )
  process.exitCode = 1
})
