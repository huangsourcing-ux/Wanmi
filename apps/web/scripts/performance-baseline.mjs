import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from '@playwright/test'
import lighthouse from 'lighthouse'

const webDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(webDirectory, 'performance', 'baseline.json')
const measureOnly = process.argv.includes('--measure')
const configuredBaseUrl = process.env.PERFORMANCE_BASE_URL
const baseUrl = new URL(configuredBaseUrl ?? `http://127.0.0.1:${await availablePort()}`)

if (!['127.0.0.1', '::1', 'localhost'].includes(baseUrl.hostname)) {
  throw new Error(`Performance baseline only accepts a loopback target, received ${baseUrl.origin}`)
}
if (process.env.ALLOW_REAL_PROVIDER_WRITES === 'true') {
  throw new Error('Performance baseline requires ALLOW_REAL_PROVIDER_WRITES=false')
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

function median(values) {
  return percentile(values, 0.5)
}

function round(value, digits = 1) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a local Chrome debug port')))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitFor(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`Local process exited before ${url} became ready (code ${child.exitCode})`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`Readiness returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : 'unknown'}`,
  )
}

async function ensureWebServer() {
  if (configuredBaseUrl) {
    await waitFor(new URL('/healthz', baseUrl), 10_000)
    return undefined
  }

  const child = spawn('pnpm', ['start'], {
    cwd: webDirectory,
    env: {
      ...process.env,
      ALLOW_REAL_PROVIDER_WRITES: 'false',
      HOSTNAME: baseUrl.hostname === 'localhost' ? '127.0.0.1' : baseUrl.hostname,
      PORT: baseUrl.port || '3100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk.toString()))
  child.stderr.on('data', (chunk) => (output += chunk.toString()))
  try {
    await waitFor(new URL('/healthz', baseUrl), 60_000, child)
  } catch (error) {
    child.kill('SIGTERM')
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${output.slice(-4_000)}`,
    )
  }
  return child
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const stopped = await Promise.race([exited.then(() => true), delay(5_000, false)])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

async function verifyLocalPageDependencies() {
  const browser = await chromium.launch({ headless: true })
  const blockedOrigins = new Set()
  try {
    const context = await browser.newContext()
    await context.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url())
      if (requestUrl.origin !== baseUrl.origin) {
        blockedOrigins.add(requestUrl.origin)
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })
    const page = await context.newPage()
    for (const target of baseline.lighthouse.pages) {
      const response = await page.goto(new URL(target.path, baseUrl).toString(), {
        waitUntil: 'networkidle',
      })
      if (!response?.ok()) {
        throw new Error(`${target.name} dependency preflight returned HTTP ${response?.status()}`)
      }
    }
  } finally {
    await browser.close()
  }
  if (blockedOrigins.size > 0) {
    throw new Error(
      `Performance pages attempted external requests: ${[...blockedOrigins].sort().join(', ')}`,
    )
  }
}

async function requestTimed(input) {
  const started = performance.now()
  try {
    const response = await fetch(new URL(input.path, baseUrl), {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers:
        input.body === undefined
          ? { 'x-request-id': input.traceId }
          : { 'content-type': 'application/json', 'x-request-id': input.traceId },
      method: input.body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(12_000),
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const validState = input.expectedStates?.includes(body?.state) ?? true
    return {
      durationMs: performance.now() - started,
      ok: response.status === 200 && validState,
      status: response.status,
    }
  } catch {
    return { durationMs: performance.now() - started, ok: false, status: 0 }
  }
}

async function loadScenario(name, settings, requestFor) {
  for (let warmup = 0; warmup < 3; warmup += 1) {
    await requestTimed(requestFor(-1, warmup))
  }
  const results = (
    await Promise.all(
      Array.from({ length: settings.concurrency }, (_, worker) =>
        Promise.all(
          Array.from({ length: settings.iterationsPerWorker }, (_, iteration) =>
            requestTimed(requestFor(worker, iteration)),
          ),
        ),
      ),
    )
  ).flat()
  const durations = results.map((result) => result.durationMs)
  const failures = results.filter((result) => !result.ok)
  return {
    errorRate: round(failures.length / results.length, 4),
    failures: failures.length,
    maximumMs: round(Math.max(...durations)),
    name,
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    requests: results.length,
  }
}

async function measureApi() {
  const token = Date.now().toString(36)
  return Promise.all([
    loadScenario('public-tool-pages', baseline.api['public-tool-pages'], (worker, iteration) => ({
      path:
        (worker + iteration) % 2 === 0
          ? '/tools/domain-search?q=wanmi.net'
          : '/tools/idn?q=wanmi.net',
      traceId: `perf-pages-${token}-${worker}-${iteration}`,
    })),
    loadScenario('domain-search', baseline.api['domain-search'], (worker, iteration) => ({
      body: { query: `perf${token}${Math.max(worker, 0)}${iteration}.com` },
      expectedStates: ['ready'],
      path: '/api/v1/tools/domain-search',
      traceId: `perf-domain-${token}-${worker}-${iteration}`,
    })),
    loadScenario('idn', baseline.api.idn, (worker, iteration) => ({
      body: { query: `perf-${token}-${Math.max(worker, 0)}-${iteration}.com` },
      expectedStates: ['ready'],
      path: '/api/v1/tools/idn',
      traceId: `perf-idn-${token}-${worker}-${iteration}`,
    })),
  ])
}

async function launchChrome() {
  const port = await availablePort()
  const profile = await mkdtemp(path.join(tmpdir(), 'wanmi-lighthouse-'))
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--no-first-run',
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
    ],
    { stdio: 'ignore' },
  )
  await waitFor(`http://127.0.0.1:${port}/json/version`, 30_000, child)
  return { child, port, profile }
}

async function lighthousePage(page, port) {
  const runs = []
  for (let run = 0; run < baseline.lighthouse.runs; run += 1) {
    const result = await lighthouse(new URL(page.path, baseUrl).toString(), {
      disableStorageReset: false,
      formFactor: 'desktop',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      output: 'json',
      port,
      screenEmulation: {
        deviceScaleFactor: 1,
        disabled: false,
        height: 900,
        mobile: false,
        width: 1440,
      },
      throttlingMethod: 'simulate',
    })
    if (!result) throw new Error(`Lighthouse returned no result for ${page.name}`)
    runs.push({
      accessibilityScore: result.lhr.categories.accessibility.score,
      bestPracticesScore: result.lhr.categories['best-practices'].score,
      cls: result.lhr.audits['cumulative-layout-shift'].numericValue,
      fcpMs: result.lhr.audits['first-contentful-paint'].numericValue,
      lcpMs: result.lhr.audits['largest-contentful-paint'].numericValue,
      performanceScore: result.lhr.categories.performance.score,
      seoScore: result.lhr.categories.seo.score,
      speedIndexMs: result.lhr.audits['speed-index'].numericValue,
      tbtMs: result.lhr.audits['total-blocking-time'].numericValue,
      ttfbMs: result.lhr.audits['server-response-time'].numericValue,
    })
  }
  return {
    accessibilityScore: round(median(runs.map((run) => run.accessibilityScore)), 2),
    bestPracticesScore: round(median(runs.map((run) => run.bestPracticesScore)), 2),
    cls: round(median(runs.map((run) => run.cls)), 3),
    fcpMs: round(median(runs.map((run) => run.fcpMs))),
    lcpMs: round(median(runs.map((run) => run.lcpMs))),
    name: page.name,
    performanceScore: round(median(runs.map((run) => run.performanceScore)), 2),
    runs: runs.length,
    seoScore: round(median(runs.map((run) => run.seoScore)), 2),
    speedIndexMs: round(median(runs.map((run) => run.speedIndexMs))),
    tbtMs: round(median(runs.map((run) => run.tbtMs))),
    ttfbMs: round(median(runs.map((run) => run.ttfbMs))),
  }
}

function assess(api, pages) {
  const failures = []
  for (const result of api) {
    const threshold = baseline.api[result.name]
    if (result.errorRate > threshold.maximumErrorRate) {
      failures.push(`${result.name} errorRate ${result.errorRate} > ${threshold.maximumErrorRate}`)
    }
    if (result.p95Ms > threshold.maximumP95Ms) {
      failures.push(`${result.name} p95 ${result.p95Ms}ms > ${threshold.maximumP95Ms}ms`)
    }
  }
  for (const page of pages) {
    const threshold = baseline.lighthouse
    const checks = [
      ['performanceScore', '>=', threshold.minimumPerformanceScore],
      ['accessibilityScore', '>=', threshold.minimumAccessibilityScore],
      ['bestPracticesScore', '>=', threshold.minimumBestPracticesScore],
      ['seoScore', '>=', threshold.minimumSeoScore],
      ['lcpMs', '<=', threshold.maximumLcpMs],
      ['tbtMs', '<=', threshold.maximumTbtMs],
      ['cls', '<=', threshold.maximumCls],
    ]
    for (const [metric, operator, expected] of checks) {
      const actual = page[metric]
      const passed = operator === '>=' ? actual >= expected : actual <= expected
      if (!passed) failures.push(`${page.name} ${metric} ${actual} ${operator} ${expected} failed`)
    }
  }
  return failures
}

let web
let chrome
try {
  web = await ensureWebServer()
  await verifyLocalPageDependencies()
  const api = await measureApi()
  chrome = await launchChrome()
  const pages = []
  for (const page of baseline.lighthouse.pages) {
    pages.push(await lighthousePage(page, chrome.port))
  }
  const report = {
    api,
    baseUrl: baseUrl.origin,
    lighthouse: pages,
    measuredAt: new Date().toISOString(),
    mode: measureOnly ? 'measure' : 'gate',
  }
  console.log(JSON.stringify(report, null, 2))
  const failures = assess(api, pages)
  if (failures.length) {
    console.error(`Performance baseline failed:\n- ${failures.join('\n- ')}`)
    if (!measureOnly) process.exitCode = 1
  }
} finally {
  if (chrome) {
    await stopChild(chrome.child)
    await rm(chrome.profile, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
  }
  if (web) await stopChild(web)
}
