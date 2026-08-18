import { describe, expect, it, vi } from 'vitest'

import { createDnsRecordItemHandlers } from '@/app/api/v1/domains/[assetId]/dns-records/[recordId]/route'
import { createDnsRecordStatusHandler } from '@/app/api/v1/domains/[assetId]/dns-records/[recordId]/status/route'
import { createDnsRecordBatchDeleteHandler } from '@/app/api/v1/domains/[assetId]/dns-records/batch-delete/route'
import { createDnsRecordBatchPreviewHandler } from '@/app/api/v1/domains/[assetId]/dns-records/batch-delete/preview/route'
import { createDnsRecordCollectionHandlers } from '@/app/api/v1/domains/[assetId]/dns-records/route'
import { AppError } from '@/lib/errors'

const customer = { collection: 'customers' as const, id: 42, status: 'active' }
const req = { headers: new Headers(), user: customer } as never
const idempotencyKey = '00000000-0000-4000-8000-000000000071'
const record = {
  host: 'www',
  id: '71',
  lineCode: '' as const,
  lineLabel: '默认' as const,
  paused: false,
  priority: 10,
  ttl: 600,
  type: 'A' as const,
  value: '192.0.2.71',
}
const mutation = {
  data: {
    changeEventId: '81',
    idempotentReplay: false,
    operationId: '91',
    operationKey: 'westdigital:dns:test',
    providerRecordId: '71',
    status: 'succeeded' as const,
  },
  state: 'ready' as const,
}

function resolveContext() {
  return Promise.resolve({ customer, req })
}

function jsonRequest(path: string, body: unknown, method = 'POST') {
  return new Request(`http://wanmi.local${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'd9d1-route' },
    method,
  })
}

const collectionContext = { params: Promise.resolve({ assetId: '7' }) }
const itemContext = { params: Promise.resolve({ assetId: '7', recordId: '71' }) }

describe('D9-D-1 DNS management routes', () => {
  it('routes strict list, detail, add, modify, delete, pause, preview, and batch-delete contracts', async () => {
    const list = vi.fn().mockResolvedValue({
      data: { items: [record], page: 1, pageCount: 1, total: 1 },
      state: 'ready',
    })
    const add = vi.fn().mockResolvedValue(mutation)
    const detail = vi.fn().mockResolvedValue({ data: record, state: 'ready' })
    const modify = vi.fn().mockResolvedValue(mutation)
    const deleteRecord = vi.fn().mockResolvedValue(mutation)
    const setPaused = vi.fn().mockResolvedValue(mutation)
    const preview = vi.fn().mockResolvedValue({
      data: {
        expiresAt: '2026-08-17T12:05:00.000Z',
        items: [record, { ...record, host: 'api', id: '72' }],
        previewToken: 'p'.repeat(80),
      },
      state: 'ready',
    })
    const deleteBatch = vi.fn().mockResolvedValue({
      data: {
        batchKey: 'a'.repeat(64),
        items: [mutation.data, { ...mutation.data, providerRecordId: '72' }],
      },
      state: 'ready',
    })
    const collection = createDnsRecordCollectionHandlers({ add, list, resolveContext })
    const item = createDnsRecordItemHandlers({ deleteRecord, detail, modify, resolveContext })

    const responses = await Promise.all([
      collection.GET(
        new Request(
          'http://wanmi.local/api/v1/domains/7/dns-records?host=www&type=A&limit=20&page=1',
        ),
        collectionContext,
      ),
      collection.POST(
        jsonRequest('/api/v1/domains/7/dns-records', {
          host: 'www',
          idempotencyKey,
          line: '默认',
          priority: 10,
          ttl: 600,
          type: 'A',
          value: '192.0.2.71',
        }),
        collectionContext,
      ),
      item.GET(new Request('http://wanmi.local/api/v1/domains/7/dns-records/71'), itemContext),
      item.PATCH(
        jsonRequest(
          '/api/v1/domains/7/dns-records/71',
          { idempotencyKey, priority: 20, ttl: 900, value: '192.0.2.72' },
          'PATCH',
        ),
        itemContext,
      ),
      item.DELETE(
        jsonRequest('/api/v1/domains/7/dns-records/71', { idempotencyKey }, 'DELETE'),
        itemContext,
      ),
      createDnsRecordStatusHandler({ resolveContext, setPaused })(
        jsonRequest('/api/v1/domains/7/dns-records/71/status', { idempotencyKey, paused: true }),
        itemContext,
      ),
      createDnsRecordBatchPreviewHandler({ preview, resolveContext })(
        jsonRequest('/api/v1/domains/7/dns-records/batch-delete/preview', {
          recordIds: ['71', '72'],
        }),
        collectionContext,
      ),
      createDnsRecordBatchDeleteHandler({ deleteBatch, resolveContext })(
        jsonRequest('/api/v1/domains/7/dns-records/batch-delete', {
          deviceId: 'route-device-00000001',
          previewToken: 'p'.repeat(80),
          recordIds: ['71', '72'],
          stepUpToken: 'a'.repeat(43),
        }),
        collectionContext,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([
      200, 201, 200, 200, 200, 200, 200, 200,
    ])
    expect(
      responses.every((response) => response.headers.get('cache-control') === 'no-store'),
    ).toBe(true)
    expect(list).toHaveBeenCalledWith(
      req,
      7,
      { host: 'www', limit: 20, page: 1, type: 'A' },
      expect.objectContaining({ customer }),
    )
    expect(add).toHaveBeenCalledWith(
      req,
      7,
      expect.objectContaining({ host: 'www', idempotencyKey, type: 'A' }),
      expect.objectContaining({ customer }),
    )
    expect(detail).toHaveBeenCalledWith(req, 7, '71', expect.objectContaining({ customer }))
    expect(modify).toHaveBeenCalledWith(
      req,
      7,
      '71',
      { idempotencyKey, priority: 20, ttl: 900, value: '192.0.2.72' },
      expect.objectContaining({ customer }),
    )
    expect(deleteRecord).toHaveBeenCalledWith(
      req,
      7,
      '71',
      { idempotencyKey },
      expect.objectContaining({ customer }),
    )
    expect(setPaused).toHaveBeenCalledWith(
      req,
      7,
      '71',
      { idempotencyKey, paused: true },
      expect.objectContaining({ customer }),
    )
    expect(preview).toHaveBeenCalledWith(
      req,
      7,
      { recordIds: ['71', '72'] },
      expect.objectContaining({ customer }),
    )
    expect(deleteBatch).toHaveBeenCalledWith(
      req,
      7,
      expect.objectContaining({ recordIds: ['71', '72'] }),
      expect.objectContaining({ customer }),
    )
  })

  it('fails closed at the authenticated-customer gate for every DNS route call point', async () => {
    const blocked = vi
      .fn()
      .mockRejectedValue(new AppError('CUSTOMER_AUTH_REQUIRED', '需要登录', 401))
    const list = vi.fn()
    const add = vi.fn()
    const detail = vi.fn()
    const modify = vi.fn()
    const deleteRecord = vi.fn()
    const setPaused = vi.fn()
    const preview = vi.fn()
    const deleteBatch = vi.fn()
    const collection = createDnsRecordCollectionHandlers({ add, list, resolveContext: blocked })
    const item = createDnsRecordItemHandlers({
      deleteRecord,
      detail,
      modify,
      resolveContext: blocked,
    })
    const responses = await Promise.all([
      collection.GET(
        new Request('http://wanmi.local/api/v1/domains/7/dns-records'),
        collectionContext,
      ),
      collection.POST(
        jsonRequest('/api/v1/domains/7/dns-records', {
          host: 'www',
          idempotencyKey,
          type: 'A',
          value: '192.0.2.71',
        }),
        collectionContext,
      ),
      item.GET(new Request('http://wanmi.local/api/v1/domains/7/dns-records/71'), itemContext),
      item.PATCH(
        jsonRequest(
          '/api/v1/domains/7/dns-records/71',
          { idempotencyKey, priority: 10, ttl: 600, value: '192.0.2.72' },
          'PATCH',
        ),
        itemContext,
      ),
      item.DELETE(
        jsonRequest('/api/v1/domains/7/dns-records/71', { idempotencyKey }, 'DELETE'),
        itemContext,
      ),
      createDnsRecordStatusHandler({ resolveContext: blocked, setPaused })(
        jsonRequest('/api/v1/domains/7/dns-records/71/status', { idempotencyKey, paused: true }),
        itemContext,
      ),
      createDnsRecordBatchPreviewHandler({ preview, resolveContext: blocked })(
        jsonRequest('/api/v1/domains/7/dns-records/batch-delete/preview', {
          recordIds: ['71', '72'],
        }),
        collectionContext,
      ),
      createDnsRecordBatchDeleteHandler({ deleteBatch, resolveContext: blocked })(
        jsonRequest('/api/v1/domains/7/dns-records/batch-delete', {
          deviceId: 'route-device-00000001',
          previewToken: 'p'.repeat(80),
          recordIds: ['71', '72'],
          stepUpToken: 'a'.repeat(43),
        }),
        collectionContext,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401, 401, 401, 401,
    ])
    expect(
      [list, add, detail, modify, deleteRecord, setPaused, preview, deleteBatch].every(
        (mock) => mock.mock.calls.length === 0,
      ),
    ).toBe(true)
  })

  it('rejects unknown query fields, invalid ids, unexpected body fields, wrong media, and oversized bodies', async () => {
    const list = vi.fn()
    const add = vi.fn()
    const detail = vi.fn()
    const collection = createDnsRecordCollectionHandlers({ add, list, resolveContext })
    const item = createDnsRecordItemHandlers({ detail, resolveContext })
    const wrongMedia = new Request('http://wanmi.local/api/v1/domains/7/dns-records', {
      body: '{}',
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
    })
    const oversized = new Request('http://wanmi.local/api/v1/domains/7/dns-records', {
      body: JSON.stringify({ value: 'x'.repeat(17_000) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const declaredOversized = new Request('http://wanmi.local/api/v1/domains/7/dns-records', {
      body: '{}',
      headers: { 'content-length': '20000', 'content-type': 'application/json' },
      method: 'POST',
    })
    const invalidJson = new Request('http://wanmi.local/api/v1/domains/7/dns-records', {
      body: '{',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const responses = await Promise.all([
      collection.GET(
        new Request('http://wanmi.local/api/v1/domains/7/dns-records?secret=value'),
        collectionContext,
      ),
      item.GET(new Request('http://wanmi.local/api/v1/domains/7/dns-records/bad'), {
        params: Promise.resolve({ assetId: '7', recordId: 'bad' }),
      }),
      collection.POST(
        jsonRequest('/api/v1/domains/7/dns-records', {
          host: 'www',
          idempotencyKey,
          type: 'A',
          unexpected: true,
          value: '192.0.2.71',
        }),
        collectionContext,
      ),
      collection.POST(wrongMedia, collectionContext),
      collection.POST(oversized, collectionContext),
      collection.POST(declaredOversized, collectionContext),
      collection.POST(invalidJson, collectionContext),
    ])
    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 415, 413, 413, 400,
    ])
    expect(list).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(detail).not.toHaveBeenCalled()
  })
})
