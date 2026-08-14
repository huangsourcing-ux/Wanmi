import { expect, test } from '@playwright/test'

import {
  readRealnameDocumentFixture,
  realnameDocumentFixturePhone,
} from './realname-document-fixture'

const captchaVerifyParam = 'wanmi-captcha-fixture-pass'

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

test('private identity documents stay encrypted and use audited short-lived access end to end', async ({
  request,
}) => {
  const fixture = await readRealnameDocumentFixture()
  const tracePrefix = 'e2e-d4-private-document'
  const deviceId = `${tracePrefix}-device`
  const otp = await request.post('/api/v1/auth/sms/request', {
    data: { captchaVerifyParam, deviceId, phone: realnameDocumentFixturePhone },
  })
  const challenge = await otp.json()
  const verified = await request.post('/api/v1/auth/sms/verify', {
    data: { challengeId: challenge.challengeId, code: '246810', deviceId },
  })
  expect(verified.status()).toBe(200)
  const cookie = cookiePair(verified.headers()['set-cookie'])
  const marker = 'E2E-PRIVATE-IDENTITY-CONTENT-4303'
  const pdf = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${marker}\n%%EOF\n`,
    'utf8',
  )

  const uploaded = await request.post(
    `/api/v1/realname/templates/${fixture.templateId}/documents`,
    {
      headers: { cookie, 'x-request-id': `${tracePrefix}-upload` },
      multipart: {
        file: { buffer: pdf, mimeType: 'application/octet-stream', name: 'forged-extension.exe' },
      },
    },
  )
  const uploadedText = await uploaded.text()
  expect(uploaded.status(), uploadedText).toBe(201)
  const uploadedBody = JSON.parse(uploadedText)
  expect(uploadedBody).toMatchObject({
    contentType: 'application/pdf',
    fileKind: 'pdf',
    status: 'active',
  })
  expect(JSON.stringify(uploadedBody)).not.toContain(marker)

  const access = await request.post(`/api/v1/realname/documents/${uploadedBody.id}/access`, {
    data: { mode: 'view' },
    headers: { cookie, 'x-request-id': `${tracePrefix}-access` },
  })
  expect(access.status()).toBe(200)
  const accessBody = await access.json()
  expect(accessBody.url).not.toContain('private/realname')
  expect(Date.parse(accessBody.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)

  const viewed = await request.get(accessBody.url, {
    headers: { cookie, 'x-request-id': `${tracePrefix}-view` },
  })
  expect(viewed.status()).toBe(200)
  expect(viewed.headers()['cache-control']).toContain('no-store')
  expect(viewed.headers()['x-content-type-options']).toBe('nosniff')
  expect(await viewed.body()).toEqual(pdf)

  const submitted = await request.post(`/api/v1/realname/documents/${uploadedBody.id}/submit`, {
    headers: { cookie, 'x-request-id': `${tracePrefix}-submit` },
  })
  expect(submitted.status()).toBe(200)
  expect(await submitted.json()).toMatchObject({ status: 'submitted' })

  const malicious = Buffer.from(
    '%PDF-1.4\n1 0 obj << /OpenAction 2 0 R >> endobj\nSECRET-MALICIOUS-CONTENT\n%%EOF\n',
  )
  const rejected = await request.post(
    `/api/v1/realname/templates/${fixture.templateId}/documents`,
    {
      headers: { cookie, 'x-request-id': `${tracePrefix}-malicious` },
      multipart: { file: { buffer: malicious, mimeType: 'application/pdf', name: 'identity.pdf' } },
    },
  )
  expect(rejected.status()).toBe(422)
  const rejectedBody = await rejected.json()
  expect(rejectedBody.code).toBe('REALNAME_DOCUMENT_MALICIOUS')
  expect(JSON.stringify(rejectedBody)).not.toContain('SECRET-MALICIOUS-CONTENT')

  const deleted = await request.delete(`/api/v1/realname/documents/${uploadedBody.id}`, {
    headers: { cookie, 'x-request-id': `${tracePrefix}-delete` },
  })
  expect(deleted.status()).toBe(200)
  expect(await deleted.json()).toMatchObject({ status: 'deleted' })
  const staleAccess = await request.get(accessBody.url, { headers: { cookie } })
  expect(staleAccess.status()).toBe(404)
  expect(JSON.stringify(await staleAccess.json())).not.toContain(marker)
})
