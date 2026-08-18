import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { executeWestDigitalOfflineHttpRequest } from '@/providers/westdigital-offline-http'

function options(fetchImpl: typeof fetch) {
  return {
    apiPassword: 'fixture-api-password',
    fetchImpl,
    maxResponseBytes: 16_384,
    now: () => 1_787_014_400_123,
    username: 'fixture-user',
  }
}

describe('West Digital V2 offline-task HTTP contract', () => {
  it('POSTs task creation with the documented millisecond signature and no redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ clientid: 'client-1', code: 200, data: true, msg: '成功' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    const response = await executeWestDigitalOfflineHttpRequest(
      {
        body: { act: 'dodelreall', data: 'example.com|www|A|192.0.2.1|默认' },
        path: '/v2/offline-task/add-dns-record-task',
        requestId: 'offline-submit',
        signal: new AbortController().signal,
      },
      options(fetchImpl),
    )

    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://newapi.west.cn/v2/offline-task/add-dns-record-task')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const fields = new URLSearchParams(String(init?.body))
    expect(Object.fromEntries(fields)).toMatchObject({
      act: 'dodelreall',
      data: 'example.com|www|A|192.0.2.1|默认',
      time: '1787014400123',
      username: 'fixture-user',
    })
    expect(fields.get('token')).toBe(
      createHash('md5').update('fixture-userfixture-api-password1787014400123').digest('hex'),
    )
  })

  it('GETs task queries with documented fields in the query string', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ clientid: 'client-2', code: 200, data: {}, msg: '成功' }), {
        status: 200,
      }),
    )
    await executeWestDigitalOfflineHttpRequest(
      {
        body: { page: '1', pageSize: '10', task_sku: 'TASK-1' },
        path: '/v2/offline-task/task-list',
        requestId: 'offline-query',
        signal: new AbortController().signal,
      },
      options(fetchImpl),
    )

    const [rawUrl, init] = fetchImpl.mock.calls[0]!
    const url = new URL(String(rawUrl))
    expect(url.origin).toBe('https://newapi.west.cn')
    expect(url.pathname).toBe('/v2/offline-task/task-list')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      page: '1',
      pageSize: '10',
      task_sku: 'TASK-1',
      username: 'fixture-user',
    })
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(init?.body).toBeUndefined()
  })

  it('rejects caller-supplied authentication fields before any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      executeWestDigitalOfflineHttpRequest(
        {
          body: { task_sku: 'TASK-1', token: 'attacker-token' },
          path: '/v2/offline-task/task-list',
          requestId: 'offline-auth-injection',
          signal: new AbortController().signal,
        },
        options(fetchImpl),
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', submission: 'not_submitted' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
