import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { getEnv } from '@/lib/env'
import {
  resolveWechatCallbackEcho,
  verifyWechatCallback,
  verifyWechatCallbackEcho,
} from '@/providers/wechatofficial'

function callbackSignature(parts: string[]): string {
  return createHash('sha1')
    .update([...parts].sort().join(''))
    .digest('hex')
}

function eventXml(input: {
  event: 'SCAN' | 'subscribe'
  eventKey: string
  openid: string
}): string {
  return `<xml><FromUserName><![CDATA[${input.openid}]]></FromUserName><Event><![CDATA[${input.event}]]></Event><EventKey><![CDATA[${input.eventKey}]]></EventKey></xml>`
}

function encryptCallback(xml: string): string {
  const env = getEnv()
  const key = Buffer.from(`${env.WECHAT_OFFICIAL_ENCODING_AES_KEY}=`, 'base64')
  const randomPrefix = randomBytes(16)
  const message = Buffer.from(xml, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(message.length)
  const plain = Buffer.concat([
    randomPrefix,
    length,
    message,
    Buffer.from(env.WECHAT_OFFICIAL_APP_ID!, 'utf8'),
  ])
  const paddingLength = 32 - (plain.length % 32)
  const padded = Buffer.concat([plain, Buffer.alloc(paddingLength, paddingLength)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

describe('Wechat Official callback trust boundary', () => {
  it('rejects an unsigned callback before parsing the event', () => {
    const scene = randomBytes(32).toString('base64url')
    const body = eventXml({ event: 'SCAN', eventKey: scene, openid: randomUUID() })

    expect(
      verifyWechatCallback({
        body,
        nonce: randomUUID(),
        signatureValue: null,
        timestamp: String(Date.now()),
      }),
    ).toBeNull()
  })

  it('accepts a correctly signed plaintext event and rejects a changed signature', () => {
    const env = getEnv()
    const scene = randomBytes(32).toString('base64url')
    const openid = randomUUID()
    const nonce = randomUUID()
    const timestamp = String(Date.now())
    const body = eventXml({ event: 'SCAN', eventKey: scene, openid })
    const signature = callbackSignature([env.WECHAT_OFFICIAL_CALLBACK_TOKEN!, timestamp, nonce])

    expect(verifyWechatCallback({ body, nonce, signatureValue: signature, timestamp })).toEqual({
      event: 'SCAN',
      eventKey: scene,
      fromUserName: openid,
    })
    expect(
      verifyWechatCallback({
        body,
        nonce,
        signatureValue: `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
        timestamp,
      }),
    ).toBeNull()
  })

  it('validates and decrypts AES callbacks while binding the plaintext to this AppID', () => {
    const env = getEnv()
    const scene = randomBytes(32).toString('base64url')
    const openid = randomUUID()
    const nonce = randomUUID()
    const timestamp = String(Date.now())
    const encrypted = encryptCallback(
      eventXml({ event: 'subscribe', eventKey: `qrscene_${scene}`, openid }),
    )
    const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`
    const signature = callbackSignature([
      env.WECHAT_OFFICIAL_CALLBACK_TOKEN!,
      timestamp,
      nonce,
      encrypted,
    ])

    expect(verifyWechatCallback({ body, nonce, signatureValue: signature, timestamp })).toEqual({
      event: 'subscribe',
      eventKey: `qrscene_${scene}`,
      fromUserName: openid,
    })
  })

  it('uses the same signature boundary for server callback URL verification', () => {
    const token = getEnv().WECHAT_OFFICIAL_CALLBACK_TOKEN!
    const nonce = randomUUID()
    const timestamp = String(Date.now())
    const echo = randomUUID()
    const signatureValue = callbackSignature([token, timestamp, nonce])

    expect(verifyWechatCallbackEcho({ echo, nonce, signatureValue, timestamp })).toBe(true)
    expect(verifyWechatCallbackEcho({ echo, nonce, signatureValue: null, timestamp })).toBe(false)

    const encryptedEcho = encryptCallback(echo)
    const encryptedSignature = callbackSignature([token, timestamp, nonce, encryptedEcho])
    expect(
      resolveWechatCallbackEcho({
        echo: encryptedEcho,
        encrypted: true,
        nonce,
        signatureValue: encryptedSignature,
        timestamp,
      }),
    ).toBe(echo)
  })
})
