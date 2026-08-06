import { expect, test, type Page, type Route } from '@playwright/test'

const observedAt = '2026-08-06T12:00:00.000Z'
const traceId = 'trace-d2-12-degradation'

function problem(
  code: string,
  detail: string,
  title: string,
  options: { action?: string; retryAfterSeconds?: number; status?: number } = {},
) {
  const status = options.status ?? 503
  return {
    action: options.action ?? '请稍后重试',
    code,
    detail,
    message: detail,
    observedAt,
    retryable: true,
    ...(options.retryAfterSeconds ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
    status,
    title,
    traceId,
    type: `urn:wanmi:problem:${code}`,
  }
}

async function isolateAnalytics(page: Page) {
  await page.route('**/api/v1/events', async (route) => {
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
}

async function requestQuery(route: Route): Promise<string> {
  const body = route.request().postDataJSON() as { query?: unknown }
  return typeof body.query === 'string' ? body.query : ''
}

function domainItem(domainAscii: string, tld: string) {
  return {
    cache: { status: 'miss' },
    dataSource: '西部数码 fixture（非实时）',
    domainAscii,
    domainUnicode: domainAscii,
    observedAt,
    status: 'available',
    tld,
  }
}

function domainPartialResult() {
  const queueProblem = problem(
    'WESTDIGITAL_QUEUE_FULL',
    '域名数据源请求过于频繁，请稍后重试',
    '可注册状态暂时未知',
    { status: 429 },
  )
  return {
    data: {
      items: [
        domainItem('queue-partial.com', 'com'),
        {
          ...domainItem('queue-partial.xyz', 'xyz'),
          problem: queueProblem,
          status: 'query_failed',
        },
      ],
      mode: 'keyword',
      normalizedQueryAscii: 'queue-partial',
      normalizedQueryUnicode: 'queue-partial',
      risks: [],
      tlds: ['com', 'xyz'],
    },
    meta: {
      cacheStatus: 'miss',
      dataSource: '西部数码 fixture（非实时）',
      observedAt,
      traceId,
    },
    problem: problem(
      'DOMAIN_SEARCH_PARTIAL',
      '1 个域名暂时无法确认，其余结果仍可查看',
      '部分域名状态无法确认',
    ),
    state: 'partial',
  }
}

function domainRateLimitedResult() {
  return {
    meta: {
      cacheStatus: 'miss',
      dataSource: '西部数码 fixture（非实时）',
      observedAt,
      traceId,
    },
    problem: problem(
      'WESTDIGITAL_RATE_LIMITED',
      '域名查询请求过于频繁，请稍后重试',
      '查询请求过于频繁',
      { retryAfterSeconds: 12, status: 429 },
    ),
    state: 'rate_limited',
  }
}

function whoisRecord() {
  return {
    dates: { created: null, expires: null, updated: null },
    domainAscii: 'fallback.example.test',
    domainUnicode: 'fallback.example.test',
    nameServers: ['ns1.example.test'],
    normalizedQueryAscii: 'fallback.example.test',
    normalizedQueryUnicode: 'fallback.example.test',
    recordStatus: 'record_found',
    registrar: 'Fallback Fixture Registrar',
    risks: [],
    source: { protocol: 'whois', provider: 'westdigital' },
    statuses: ['client transfer prohibited'],
  }
}

function whoisDegradedResult() {
  return {
    data: whoisRecord(),
    meta: {
      cacheStatus: 'miss',
      dataSource: '西部数码 WHOIS（Who-Dat 降级）',
      observedAt,
      traceId,
    },
    problem: problem(
      'WHOIS_FALLBACK_USED',
      'Who-Dat 暂时不可用，当前展示西部数码 WHOIS 降级结果',
      '当前使用降级数据源',
      { action: '请稍后重试；不要据此推断域名是否可注册' },
    ),
    state: 'degraded',
  }
}

function whoisErrorResult() {
  return {
    meta: {
      cacheStatus: 'miss',
      dataSource: 'Who-Dat RDAP/WHOIS + 西部数码 WHOIS',
      observedAt,
      traceId,
    },
    problem: problem(
      'WHOIS_SOURCES_UNAVAILABLE',
      '两个公开注册数据源均未能完成本次查询',
      'WHOIS 查询暂时不可用',
      { action: '请稍后重试；不要据此推断域名是否可注册' },
    ),
    state: 'error',
  }
}

function dnsRecordSets(partial: boolean) {
  const types = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA'] as const
  return types.map((type) => {
    if (partial && type === 'A') {
      return {
        cacheStatus: 'miss',
        observedAt,
        records: [{ address: '93.184.216.34', ownerName: 'dns-partial.example.test', ttl: 60, type }],
        resolverNode: 'alidns_primary',
        status: 'records',
        type,
      }
    }
    if (partial && type === 'AAAA') {
      return {
        cacheStatus: 'miss',
        issue: { code: 'DNS_TIMEOUT', message: 'DNS 查询超时', retryable: true },
        observedAt,
        records: [],
        resolverNode: 'alidns_primary',
        status: 'timeout',
        type,
      }
    }
    return {
      cacheStatus: 'miss',
      observedAt,
      records: [],
      resolverNode: 'alidns_primary',
      status: 'no_record',
      type,
    }
  })
}

function dnsPartialResult() {
  return {
    data: {
      normalizedQueryAscii: 'dns-partial.example.test',
      normalizedQueryUnicode: 'dns-partial.example.test',
      recordSets: dnsRecordSets(true),
      risks: [],
    },
    meta: {
      cacheStatus: 'miss',
      dataSource: '阿里公共 DNS（受控 DoH）',
      observedAt,
      traceId,
    },
    problem: problem(
      'DNS_PARTIAL_RESULT',
      '部分 DNS 记录类型未能完成查询，其余结果仍可查看',
      '部分 DNS 记录暂时无法确认',
    ),
    state: 'partial',
  }
}

function dnsUnavailableResult(queueFull: boolean) {
  return {
    meta: {
      cacheStatus: 'miss',
      dataSource: '阿里公共 DNS（受控 DoH）',
      observedAt,
      traceId,
    },
    problem: queueFull
      ? problem(
          'DNS_RATE_LIMITED',
          '当前 DNS 查询请求较多，请稍后重试',
          'DNS 查询暂时不可用',
          { status: 429 },
        )
      : problem('DNS_TIMEOUT', 'DNS 查询超时', 'DNS 查询暂时不可用'),
    state: queueFull ? 'rate_limited' : 'error',
  }
}

function sslPartialResult(code: 'TLS_HANDSHAKE_FAILED' | 'TLS_TIMEOUT') {
  const handshakeFailed = code === 'TLS_HANDSHAKE_FAILED'
  const message = handshakeFailed ? '目标未能完成 TLS 握手' : 'TLS 连接或握手超时'
  return {
    data: {
      caa: {
        effectiveOwnerName: null,
        inherited: false,
        records: [],
        source: {
          cacheStatus: 'miss',
          dataSource: '阿里公共 DNS（受控 DoH）',
          observedAt,
        },
        status: 'no_record',
      },
      normalizedQueryAscii: handshakeFailed
        ? 'handshake.example.test'
        : 'tls-timeout.example.test',
      normalizedQueryUnicode: handshakeFailed
        ? 'handshake.example.test'
        : 'tls-timeout.example.test',
      risks: [],
      tls: {
        certificate: null,
        cipherSuite: null,
        findings: [],
        issue: { code, message, retryable: true },
        port: 443,
        protocol: null,
        source: {
          cacheStatus: 'miss',
          dataSource: '直接 TLS 443 握手（Node.js 系统信任库）',
          observedAt,
        },
        status: handshakeFailed ? 'handshake_failed' : 'timeout',
      },
    },
    meta: {
      cacheStatus: 'miss',
      dataSource: '阿里公共 DNS + 直接 TLS 443 握手',
      observedAt,
      traceId,
    },
    problem: problem(code, `${message}；CAA 结果仍可查看`, 'SSL 检查仅部分完成'),
    state: 'partial',
  }
}

function sslUnavailableResult(queueFull: boolean) {
  return {
    meta: {
      cacheStatus: 'miss',
      dataSource: '阿里公共 DNS + 直接 TLS 443 握手',
      observedAt,
      traceId,
    },
    problem: queueFull
      ? problem('TLS_RATE_LIMITED', 'TLS 与 DNS 查询队列当前繁忙', 'SSL 检查请求受限', {
          status: 429,
        })
      : problem(
          'SSL_CHECK_UNAVAILABLE',
          'TLS 与 CAA 均未能取得可用诊断数据',
          'SSL 检查暂时不可用',
        ),
    state: queueFull ? 'rate_limited' : 'error',
  }
}

test.describe('D2-12 visible degradation contracts', () => {
  test('West Digital 429 and queue saturation stay visible without losing independent TLD results', async ({
    page,
  }) => {
    await isolateAnalytics(page)
    await page.route('**/api/v1/tools/domain-search', async (route) => {
      const query = await requestQuery(route)
      await route.fulfill({
        json: query === 'queue-partial' ? domainPartialResult() : domainRateLimitedResult(),
      })
    })

    await page.goto('/tools/domain-search?q=queue-partial')
    await expect(page.getByRole('heading', { name: '部分域名状态无法确认' })).toBeVisible()
    await expect(page.locator('[data-domain-status="available"]')).toContainText(
      'queue-partial.com',
    )
    const failed = page.locator('[data-domain-status="query_failed"]')
    await expect(failed).toContainText('queue-partial.xyz')
    await expect(failed).toContainText('域名数据源请求过于频繁，请稍后重试')
    await expect(failed).not.toHaveAttribute('data-domain-status', 'available')
    await expect(page.getByRole('link', { name: /购买|在 Wanmi 注册|立即注册/u })).toHaveCount(0)

    await page.goto('/tools/domain-search?q=rate-limited.com')
    const alert = page.locator('[data-slot="alert"][role="alert"]')
    await expect(alert.getByRole('heading', { name: '查询请求过于频繁' })).toBeVisible()
    await expect(alert).toContainText('域名查询请求过于频繁，请稍后重试')
    await expect(alert).toContainText('建议动作：请稍后重试')
    await expect(alert).toContainText(traceId)
    await expect(page.locator('[data-domain-status]')).toHaveCount(0)
  })

  test('Who-Dat failure exposes fallback or a clear error and never becomes availability', async ({
    page,
  }) => {
    await isolateAnalytics(page)
    await page.route('**/api/v1/tools/whois', async (route) => {
      const query = await requestQuery(route)
      await route.fulfill({
        json: query === 'fallback.example.test' ? whoisDegradedResult() : whoisErrorResult(),
      })
    })

    await page.goto('/tools/whois?q=fallback.example.test')
    await expect(page.getByRole('heading', { name: '当前使用降级数据源' })).toBeVisible()
    await expect(page.getByText('Fallback Fixture Registrar')).toBeVisible()
    await expect(page.getByText(/当前展示西部数码 WHOIS 降级结果/u)).toBeVisible()
    await expect(page.getByRole('link', { name: /购买|在 Wanmi 注册|立即注册/u })).toHaveCount(0)

    await page.goto('/tools/whois?q=unavailable.example.test')
    const alert = page.locator('[data-slot="alert"][role="alert"]')
    await expect(alert.getByRole('heading', { name: 'WHOIS 查询暂时不可用' })).toBeVisible()
    await expect(alert).toContainText('两个公开注册数据源均未能完成本次查询')
    await expect(alert).toContainText('不要据此推断域名是否可注册')
    await expect(page.locator('[data-record-status]')).toHaveCount(0)
  })

  test('DNS timeout keeps successful record types and exposes all-failed and queue-full states', async ({
    page,
  }) => {
    await isolateAnalytics(page)
    await page.route('**/api/v1/tools/dns', async (route) => {
      const query = await requestQuery(route)
      const json = query.startsWith('dns-partial')
        ? dnsPartialResult()
        : dnsUnavailableResult(query.startsWith('dns-queue'))
      await route.fulfill({ json })
    })

    await page.goto('/tools/dns?q=dns-partial.example.test')
    await expect(page.getByRole('heading', { name: '部分 DNS 记录暂时无法确认' })).toBeVisible()
    await expect(page.locator('[data-dns-type="A"]')).toHaveAttribute('data-dns-status', 'records')
    await expect(page.locator('[data-dns-type="AAAA"]')).toHaveAttribute(
      'data-dns-status',
      'timeout',
    )
    await expect(page.locator('[data-dns-type="AAAA"]')).toContainText('DNS 查询超时')

    await page.goto('/tools/dns?q=dns-timeout.example.test')
    await expect(page.locator('[data-slot="alert"][role="alert"]')).toContainText('DNS 查询超时')
    await expect(page.locator('[data-dns-type]')).toHaveCount(0)

    await page.goto('/tools/dns?q=dns-queue.example.test')
    const alert = page.locator('[data-slot="alert"][role="alert"]')
    await expect(alert).toContainText('当前 DNS 查询请求较多，请稍后重试')
    await expect(alert).toContainText('是否可以重试是')
    await expect(page.locator('[data-dns-type]')).toHaveCount(0)
  })

  test('TLS timeout and handshake failure retain CAA while complete failure stays explicit', async ({
    page,
  }) => {
    await isolateAnalytics(page)
    await page.route('**/api/v1/tools/ssl-check', async (route) => {
      const query = await requestQuery(route)
      const json = query.startsWith('tls-timeout')
        ? sslPartialResult('TLS_TIMEOUT')
        : query.startsWith('handshake')
          ? sslPartialResult('TLS_HANDSHAKE_FAILED')
          : sslUnavailableResult(query.startsWith('tls-queue'))
      await route.fulfill({ json })
    })

    await page.goto('/tools/ssl-check?q=tls-timeout.example.test')
    await expect(page.getByRole('heading', { name: 'SSL 检查仅部分完成' })).toBeVisible()
    await expect(page.locator('[data-tls-status="timeout"]')).toContainText('TLS 连接或握手超时')
    await expect(page.locator('[data-caa-status="no_record"]')).toBeVisible()

    await page.goto('/tools/ssl-check?q=handshake.example.test')
    await expect(page.locator('[data-tls-status="handshake_failed"]')).toContainText(
      '目标未能完成 TLS 握手',
    )
    await expect(page.locator('[data-caa-status="no_record"]')).toBeVisible()

    await page.goto('/tools/ssl-check?q=tls-unavailable.example.test')
    await expect(page.locator('[data-slot="alert"][role="alert"]')).toContainText(
      'TLS 与 CAA 均未能取得可用诊断数据',
    )
    await expect(page.locator('[data-tls-status], [data-caa-status]')).toHaveCount(0)

    await page.goto('/tools/ssl-check?q=tls-queue.example.test')
    await expect(page.locator('[data-slot="alert"][role="alert"]')).toContainText(
      'TLS 与 DNS 查询队列当前繁忙',
    )
    await expect(page.locator('[data-tls-status], [data-caa-status]')).toHaveCount(0)
  })
})
