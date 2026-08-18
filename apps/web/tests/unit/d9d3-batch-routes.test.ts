import { describe, expect, it, vi } from 'vitest'

import { createDnsRecordBatchQueryHandler } from '@/app/api/v1/domains/[assetId]/dns-records/batch-delete/[batchKey]/route'
import { createNameserverBatchQueryHandler } from '@/app/api/v1/domains/nameservers/batch/[batchKey]/route'
import { createNameserverBatchPreviewHandler } from '@/app/api/v1/domains/nameservers/batch/preview/route'
import { createNameserverBatchHandler } from '@/app/api/v1/domains/nameservers/batch/route'

const customer = { collection: 'customers' as const, id: 42, status: 'active' }
const req = { headers: new Headers(), user: customer } as never
const batchKey = '00000000-0000-4000-8000-000000000093'

function context() {
  return Promise.resolve({ customer, req })
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://wanmi.local${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'd9d3-route' },
    method: 'POST',
  })
}

describe('D9-D-3 batch routes', () => {
  it('routes DNS task query plus NS preview, execution, and query with strict schemas', async () => {
    const dnsQuery = vi.fn().mockResolvedValue({
      data: {
        batchKey: 'a'.repeat(64),
        items: [
          {
            changeEventId: '1',
            idempotentReplay: true,
            operationId: '2',
            operationKey: 'westdigital:dns_record_batch_delete:7:item',
            providerRecordId: '71',
            providerTaskKey: 'TASK-71',
            status: 'pending_query',
          },
        ],
      },
      state: 'ready',
    })
    const preview = vi.fn().mockResolvedValue({
      data: {
        batchKey,
        expiresAt: '2026-08-18T04:05:00.000Z',
        items: [
          {
            assetId: '7',
            currentNameservers: ['ns1.before.example', 'ns2.before.example'],
            domainAscii: 'one.example',
            requestedNameservers: ['ns1.after.example', 'ns2.after.example'],
          },
          {
            assetId: '8',
            currentNameservers: ['ns1.before.example', 'ns2.before.example'],
            domainAscii: 'two.example',
            requestedNameservers: ['ns1.after.example', 'ns2.after.example'],
          },
        ],
        previewToken: 'p'.repeat(80),
      },
      state: 'ready',
    })
    const batchResult = {
      data: {
        batchKey,
        items: [
          {
            assetId: '7',
            changeId: '70',
            domainAscii: 'one.example',
            itemKey: 'nameserver:7:item',
            status: 'pending_query' as const,
          },
          {
            assetId: '8',
            changeId: '80',
            domainAscii: 'two.example',
            itemKey: 'nameserver:8:item',
            status: 'pending_query' as const,
          },
        ],
      },
      state: 'ready' as const,
    }
    const execute = vi.fn().mockResolvedValue(batchResult)
    const query = vi.fn().mockResolvedValue(batchResult)
    const previewInput = {
      assetIds: [7, 8],
      batchKey,
      nameservers: ['ns1.after.example', 'ns2.after.example'],
    }
    const executionInput = {
      ...previewInput,
      confirmed: true,
      deviceId: 'route-device-00000003',
      previewToken: 'p'.repeat(80),
      stepUpToken: 'a'.repeat(43),
    }

    const responses = await Promise.all([
      createDnsRecordBatchQueryHandler({ queryBatch: dnsQuery, resolveContext: context })(
        new Request(
          `http://wanmi.local/api/v1/domains/7/dns-records/batch-delete/${'a'.repeat(64)}`,
        ),
        { params: Promise.resolve({ assetId: '7', batchKey: 'a'.repeat(64) }) },
      ),
      createNameserverBatchPreviewHandler({ preview, resolveContext: context })(
        jsonRequest('/api/v1/domains/nameservers/batch/preview', previewInput),
      ),
      createNameserverBatchHandler({ requestBatch: execute, resolveContext: context })(
        jsonRequest('/api/v1/domains/nameservers/batch', executionInput),
      ),
      createNameserverBatchQueryHandler({ queryBatch: query, resolveContext: context })(
        new Request(`http://wanmi.local/api/v1/domains/nameservers/batch/${batchKey}`),
        { params: Promise.resolve({ batchKey }) },
      ),
    ])

    expect(responses.map((response) => response.status)).toEqual([200, 200, 202, 200])
    expect(dnsQuery).toHaveBeenCalledWith(
      req,
      7,
      'a'.repeat(64),
      expect.objectContaining({ customer }),
    )
    expect(preview).toHaveBeenCalledWith(req, previewInput, expect.objectContaining({ customer }))
    expect(execute).toHaveBeenCalledWith(req, executionInput, expect.objectContaining({ customer }))
    expect(query).toHaveBeenCalledWith(req, batchKey, expect.objectContaining({ customer }))
  })

  it('rejects unknown NS fields and invalid batch identifiers before services run', async () => {
    const preview = vi.fn()
    const query = vi.fn()
    const responses = await Promise.all([
      createNameserverBatchPreviewHandler({ preview, resolveContext: context })(
        jsonRequest('/api/v1/domains/nameservers/batch/preview', {
          assetIds: [7, 8],
          batchKey,
          nameservers: ['ns1.after.example', 'ns2.after.example'],
          unexpected: true,
        }),
      ),
      createNameserverBatchQueryHandler({ queryBatch: query, resolveContext: context })(
        new Request('http://wanmi.local/api/v1/domains/nameservers/batch/not-a-uuid'),
        { params: Promise.resolve({ batchKey: 'not-a-uuid' }) },
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([400, 400])
    expect(preview).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })
})
