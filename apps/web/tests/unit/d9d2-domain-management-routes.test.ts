import { describe, expect, it, vi } from 'vitest'

import { createDomainCapabilitiesHandler } from '@/app/api/v1/domains/[assetId]/capabilities/route'
import { createDomainCertificateHandler } from '@/app/api/v1/domains/[assetId]/certificate/route'
import { createContactInformationHandler } from '@/app/api/v1/domains/[assetId]/contact-information/route'
import { createManagementPasswordHandler } from '@/app/api/v1/domains/[assetId]/management-password/route'
import { createTemplateTransferHandler } from '@/app/api/v1/domains/[assetId]/template-transfer/route'
import { AppError } from '@/lib/errors'

const customer = { collection: 'customers' as const, id: 42, status: 'active' }
const req = { headers: new Headers(), user: customer } as never
const provider = {} as never
const context = { params: Promise.resolve({ assetId: '7' }) }
const grant = { deviceId: 'domain-route-device-001', stepUpToken: 'A'.repeat(43) }
const idempotencyKey = '00000000-0000-4000-8000-000000000211'

function resolveContext() {
  return Promise.resolve({ customer, req })
}

function jsonRequest(path: string, body: unknown, method = 'POST') {
  return new Request(`http://wanmi.local${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'd9d2-domain-route' },
    method,
  })
}

describe('D9-D-2 domain management routes', () => {
  it('returns no-store for password reveal and modification, contact, transfer, certificate, and capabilities', async () => {
    const reveal = vi.fn().mockResolvedValue({
      data: { managementPassword: 'RoutePassword12' },
      state: 'ready',
    })
    const mutation = {
      data: {
        idempotentReplay: false,
        operationId: '17',
        operationKey: 'westdigital:domain:test',
        status: 'succeeded' as const,
      },
      state: 'ready' as const,
    }
    const modify = vi.fn().mockResolvedValue(mutation)
    const update = vi.fn().mockResolvedValue(mutation)
    const transfer = vi.fn().mockResolvedValue(mutation)
    const download = vi.fn().mockResolvedValue({
      bytes: new TextEncoder().encode('certificate'),
      domainAscii: 'example.com',
    })
    const capabilities = vi.fn().mockResolvedValue({
      data: {
        capabilities: [
          { name: 'asset_sync', supported: true },
          { name: 'certificate_download', supported: true },
          { name: 'contact_information_update', supported: true },
          { name: 'domain_lock_status', supported: true },
          { name: 'management_password_read', supported: true },
          { name: 'management_password_write', supported: true },
          {
            name: 'realtime_transfer',
            supported: false,
            unsupportedCode: 'DOMAIN_CAPABILITY_REALTIME_TRANSFER_UNSUPPORTED',
          },
          { name: 'template_transfer', supported: true },
        ],
      },
      state: 'ready',
    })
    const password = createManagementPasswordHandler({ modify, provider, resolveContext, reveal })
    const responses = await Promise.all([
      password.POST(jsonRequest('/api/v1/domains/7/management-password', grant), context),
      password.PUT(
        jsonRequest(
          '/api/v1/domains/7/management-password',
          { ...grant, idempotencyKey, managementPassword: 'ChangedPassword12' },
          'PUT',
        ),
        context,
      ),
      createContactInformationHandler({ provider, resolveContext, update })(
        jsonRequest(
          '/api/v1/domains/7/contact-information',
          {
            ...grant,
            confirmed: true,
            contactType: 'dom_id',
            idempotencyKey,
            templateId: 5,
          },
          'PUT',
        ),
        context,
      ),
      createTemplateTransferHandler({ provider, resolveContext, transfer })(
        jsonRequest('/api/v1/domains/7/template-transfer', {
          ...grant,
          confirmed: true,
          idempotencyKey,
          templateId: 5,
        }),
        context,
      ),
      createDomainCertificateHandler({ download, provider, resolveContext })(
        new Request('http://wanmi.local/api/v1/domains/7/certificate'),
        context,
      ),
      createDomainCapabilitiesHandler({ capabilities, resolveContext })(
        new Request('http://wanmi.local/api/v1/domains/7/capabilities'),
        context,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(
      responses.every((response) => response.headers.get('cache-control') === 'no-store'),
    ).toBe(true)
    expect(responses[0]?.headers.get('cache-control')).toBe('no-store')
    expect(responses[4]?.headers.get('content-disposition')).toBe(
      'attachment; filename="example.com.certificate"',
    )
    expect(reveal).toHaveBeenCalledWith(req, 7, grant, expect.objectContaining({ customer }))
    expect(modify).toHaveBeenCalledWith(
      req,
      7,
      expect.objectContaining({ idempotencyKey, managementPassword: 'ChangedPassword12' }),
      expect.objectContaining({ customer }),
    )
  })

  it('fails closed at the authenticated-customer gate for every route call point', async () => {
    const blocked = vi
      .fn()
      .mockRejectedValue(new AppError('CUSTOMER_AUTH_REQUIRED', '需要登录', 401))
    const reveal = vi.fn()
    const modify = vi.fn()
    const update = vi.fn()
    const transfer = vi.fn()
    const download = vi.fn()
    const capabilities = vi.fn()
    const password = createManagementPasswordHandler({
      modify,
      provider,
      resolveContext: blocked,
      reveal,
    })
    const responses = await Promise.all([
      password.POST(jsonRequest('/password', grant), context),
      password.PUT(
        jsonRequest(
          '/password',
          { ...grant, idempotencyKey, managementPassword: 'ChangedPassword12' },
          'PUT',
        ),
        context,
      ),
      createContactInformationHandler({ provider, resolveContext: blocked, update })(
        jsonRequest(
          '/contact',
          { ...grant, confirmed: true, contactType: 'dom_id', idempotencyKey, templateId: 5 },
          'PUT',
        ),
        context,
      ),
      createTemplateTransferHandler({ provider, resolveContext: blocked, transfer })(
        jsonRequest('/transfer', { ...grant, confirmed: true, idempotencyKey, templateId: 5 }),
        context,
      ),
      createDomainCertificateHandler({ download, provider, resolveContext: blocked })(
        new Request('http://wanmi.local/certificate'),
        context,
      ),
      createDomainCapabilitiesHandler({ capabilities, resolveContext: blocked })(
        new Request('http://wanmi.local/capabilities'),
        context,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401])
    expect(
      [reveal, modify, update, transfer, download, capabilities].every(
        (mock) => mock.mock.calls.length === 0,
      ),
    ).toBe(true)
  })

  it('rejects invalid ids, missing risk fields, unexpected fields, wrong media, and oversized bodies', async () => {
    const reveal = vi.fn()
    const update = vi.fn()
    const transfer = vi.fn()
    const download = vi.fn()
    const capabilities = vi.fn()
    const password = createManagementPasswordHandler({ provider, resolveContext, reveal })
    const invalidContext = { params: Promise.resolve({ assetId: 'bad' }) }
    const responses = await Promise.all([
      password.POST(jsonRequest('/password', grant), invalidContext),
      createContactInformationHandler({ provider, resolveContext, update })(
        jsonRequest(
          '/contact',
          { ...grant, confirmed: true, contactType: 'dom_id', idempotencyKey, templateId: 5 },
          'PUT',
        ),
        invalidContext,
      ),
      createTemplateTransferHandler({ provider, resolveContext, transfer })(
        jsonRequest('/transfer', { ...grant, confirmed: true, idempotencyKey, templateId: 5 }),
        invalidContext,
      ),
      createDomainCertificateHandler({ download, provider, resolveContext })(
        new Request('http://wanmi.local/certificate'),
        invalidContext,
      ),
      createDomainCapabilitiesHandler({ capabilities, resolveContext })(
        new Request('http://wanmi.local/capabilities'),
        invalidContext,
      ),
      password.POST(jsonRequest('/password', { deviceId: grant.deviceId }), context),
      password.POST(jsonRequest('/password', { ...grant, unexpected: true }), context),
      password.POST(
        new Request('http://wanmi.local/password', {
          body: '{}',
          headers: { 'content-type': 'text/plain' },
          method: 'POST',
        }),
        context,
      ),
      password.POST(
        new Request('http://wanmi.local/password', {
          body: '{}',
          headers: { 'content-length': '17000', 'content-type': 'application/json' },
          method: 'POST',
        }),
        context,
      ),
      password.POST(
        new Request('http://wanmi.local/password', {
          body: JSON.stringify({ value: 'x'.repeat(17_000) }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        context,
      ),
      password.POST(
        new Request('http://wanmi.local/password', {
          body: '{',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        context,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400, 400, 400, 415, 413, 413, 400,
    ])
    expect(
      [reveal, update, transfer, download, capabilities].every(
        (mock) => mock.mock.calls.length === 0,
      ),
    ).toBe(true)
  })
})
