import { randomUUID } from 'node:crypto'

import {
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import OSS from 'ali-oss'

import { AliOssRealnameProvider } from '../src/providers/oss-realname'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required D0 OSS setting: ${name}`)
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function normalizeEtag(value: string | undefined): string {
  return value?.replaceAll('"', '') ?? ''
}

function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

async function isMissingObject(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return false
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    return status === 404
  }
}

const accessKeyId = required('ALIBABA_CLOUD_ACCESS_KEY_ID')
const accessKeySecret = required('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
const publicBucket = required('S3_BUCKET')
const publicEndpoint = required('S3_ENDPOINT')
const publicRegion = required('S3_REGION')
const privateBucket = required('OSS_REALNAME_BUCKET')
const privateEndpoint = required('OSS_REALNAME_ENDPOINT')

const traceId = randomUUID()
const fixture = new TextEncoder().encode(`wanmi-d0-oss-fixture:${traceId}`)
const publicKey = `d0/public/${traceId}/fixture.txt`
const privateKey = `d0/private/${traceId}/fixture.txt`

const s3 = new S3Client({
  credentials: { accessKeyId, secretAccessKey: accessKeySecret },
  endpoint: publicEndpoint,
  forcePathStyle: false,
  region: publicRegion,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

const privateProvider = new AliOssRealnameProvider(
  new OSS({
    accessKeyId,
    accessKeySecret,
    bucket: privateBucket,
    endpoint: privateEndpoint,
    secure: true,
    timeout: 15_000,
  }),
)

let publicObjectCreated = false
let privateObjectCreated = false

try {
  const acl = await s3.send(new GetBucketAclCommand({ Bucket: publicBucket }))
  const hasPublicGrant = acl.Grants?.some((grant) => grant.Grantee?.URI?.includes('AllUsers'))
  assert(!hasPublicGrant, 'D0 OSS bucket must not grant anonymous access')

  const publicPut = await s3.send(
    new PutObjectCommand({
      Body: fixture,
      Bucket: publicBucket,
      ContentType: 'text/plain; charset=utf-8',
      Key: publicKey,
    }),
  )
  publicObjectCreated = true
  assert(normalizeEtag(publicPut.ETag).length > 0, 'S3 upload did not return an ETag')

  const publicHead = await s3.send(new HeadObjectCommand({ Bucket: publicBucket, Key: publicKey }))
  assert(normalizeEtag(publicHead.ETag).length > 0, 'S3 HEAD did not return an ETag')

  const publicGet = await s3.send(new GetObjectCommand({ Bucket: publicBucket, Key: publicKey }))
  const publicBody = new Uint8Array(await publicGet.Body!.transformToByteArray())
  assert(sameBytes(publicBody, fixture), 'S3 read returned different content')

  const publicSignedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: publicBucket, Key: publicKey }),
    { expiresIn: 60 },
  )
  const publicSignedRead = await fetch(publicSignedUrl, { signal: AbortSignal.timeout(15_000) })
  assert(publicSignedRead.ok, 'S3 signed read failed')
  assert(
    sameBytes(new Uint8Array(await publicSignedRead.arrayBuffer()), fixture),
    'S3 signed read returned different content',
  )

  const privatePut = await privateProvider.upload({ body: fixture, key: privateKey, traceId })
  assert(privatePut.ok && privatePut.data.etag.length > 0, 'Private ali-oss upload failed')
  privateObjectCreated = true

  const privateRead = await privateProvider.read({ key: privateKey, traceId })
  assert(privateRead.ok && sameBytes(privateRead.data.body, fixture), 'Private ali-oss read failed')

  const privateSigned = await privateProvider.signRead({
    expiresSeconds: 60,
    key: privateKey,
    traceId,
  })
  assert(privateSigned.ok, 'Private ali-oss signing failed')
  const privateSignedRead = await fetch(privateSigned.data.url, {
    signal: AbortSignal.timeout(15_000),
  })
  assert(privateSignedRead.ok, 'Private ali-oss signed read failed')
  assert(
    sameBytes(new Uint8Array(await privateSignedRead.arrayBuffer()), fixture),
    'Private ali-oss signed read returned different content',
  )

  const privateDelete = await privateProvider.deleteObject({ key: privateKey, traceId })
  assert(privateDelete.ok, 'Private ali-oss delete failed')
  privateObjectCreated = false
  const privateAfterDelete = await privateProvider.read({ key: privateKey, traceId })
  assert(!privateAfterDelete.ok, 'Private ali-oss object still exists after delete')

  await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: publicKey }))
  publicObjectCreated = false
  assert(await isMissingObject(s3, publicBucket, publicKey), 'S3 object still exists after delete')

  process.stdout.write(
    `${JSON.stringify({
      bucketAcl: 'private',
      cleanup: 'verified',
      privateAliOss: 'passed',
      publicS3: 'passed',
      signedUrlSeconds: 60,
    })}\n`,
  )
} catch {
  process.stderr.write('Real OSS D0 verification failed; provider details were suppressed.\n')
  process.exitCode = 1
} finally {
  const cleanup = await Promise.allSettled([
    publicObjectCreated
      ? s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: publicKey }))
      : Promise.resolve(),
    privateObjectCreated
      ? privateProvider.deleteObject({ key: privateKey, traceId })
      : Promise.resolve(),
  ])
  if (cleanup.some((result) => result.status === 'rejected')) {
    process.stderr.write('Real OSS D0 cleanup failed; manual prefix inspection is required.\n')
    process.exitCode = 1
  }
  s3.destroy()
}
