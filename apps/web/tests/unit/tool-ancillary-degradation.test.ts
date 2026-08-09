// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { loadAdvertisement } from '@/components/advertising/advertising-slot'
import { emitFirstPartyEvent } from '@/lib/analytics'
import { PUBLIC_TOOL_DEFINITIONS } from '@/lib/site-config'
import { createCachedPublicToolRelationsReader } from '@/services/content/read-tool-relations'

describe('D7 public tool ancillary-service degradation', () => {
  it('keeps all six tool contexts available when CMS, advertising, and analytics fail', async () => {
    const cmsFailure = vi.fn().mockRejectedValue(new Error('CMS unavailable'))
    const analyticsCatches: Array<ReturnType<typeof vi.spyOn>> = []
    const analyticsFailure = vi.fn().mockImplementation(() => {
      const failedRequest = Promise.reject(new Error('analytics unavailable'))
      analyticsCatches.push(vi.spyOn(failedRequest, 'catch'))
      return failedRequest
    })
    vi.stubGlobal('fetch', analyticsFailure)
    const readRelations = createCachedPublicToolRelationsReader(cmsFailure)
    const results = await Promise.all(
      PUBLIC_TOOL_DEFINITIONS.map(async (tool) => {
        emitFirstPartyEvent({
          event: 'tool_submitted',
          fromLocalHistory: false,
          inputType: 'keyword',
          schemaVersion: 1,
          tool: tool.slug,
        })
        return {
          advertisement: await loadAdvertisement(
            { pageType: 'tool', placementCode: 'tool-after-result' },
            vi.fn().mockRejectedValue(new Error('advertising disabled')),
          ),
          relations: await readRelations(tool.slug),
          tool,
        }
      }),
    )

    await vi.waitFor(() => expect(analyticsFailure).toHaveBeenCalledTimes(6))
    expect(analyticsCatches).toHaveLength(6)
    for (const catchFailure of analyticsCatches) expect(catchFailure).toHaveBeenCalledOnce()

    expect(results).toHaveLength(6)
    expect(results.map(({ tool }) => tool.slug)).toEqual([
      'domain-search',
      'whois',
      'dns',
      'ssl-check',
      'idn',
      'pricing',
    ])
    for (const result of results) {
      expect(result.advertisement, result.tool.slug).toBeNull()
      expect(result.relations, result.tool.slug).toEqual({ content: [], tldPages: [] })
      expect(result.tool.href).toMatch(/^\/(?:pricing|tools\/)/u)
    }
    expect(cmsFailure).toHaveBeenCalledOnce()
    for (const request of analyticsFailure.mock.calls) {
      expect(request[0]).toBe('/api/v1/events')
      expect(request[1]).toMatchObject({ credentials: 'omit', method: 'POST' })
    }
  })
})
