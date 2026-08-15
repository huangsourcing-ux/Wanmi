import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from '@playwright/test'
import { launch, Launcher } from 'chrome-launcher'
import lighthouse from 'lighthouse'

import {
  median,
  round,
  runScenariosSequentially,
  runWarmupThenMeasurements,
  summarizeScenarioRounds,
} from './performance-statistics.mjs'

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
    detached: process.platform !== 'win32',
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
    await stopChild(child)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${output.slice(-4_000)}`,
    )
  }
  return child
}

function signalProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    }
  }
  return child.kill(signal)
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  signalProcessTree(child, 'SIGTERM')
  const stopped = await Promise.race([exited.then(() => true), delay(5_000, false)])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    signalProcessTree(child, 'SIGKILL')
    const killed = await Promise.race([exited.then(() => true), delay(2_000, false)])
    if (!killed) throw new Error(`Local process tree ${child.pid ?? 'unknown'} did not exit`)
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
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
    await requestTimed(requestFor(-1, warmup, -1))
  }
  const roundResults = []
  for (
    let measurementRound = 0;
    measurementRound < (settings.measurementRounds ?? 1);
    measurementRound += 1
  ) {
    roundResults.push(
      (
        await Promise.all(
          Array.from({ length: settings.concurrency }, (_, worker) =>
            Promise.all(
              Array.from({ length: settings.iterationsPerWorker }, (_, iteration) =>
                requestTimed(requestFor(worker, iteration, measurementRound)),
              ),
            ),
          ),
        )
      ).flat(),
    )
  }
  return {
    name,
    ...summarizeScenarioRounds(roundResults),
  }
}

async function measureApi() {
  const token = Date.now().toString(36)
  return runScenariosSequentially([
    () =>
      loadScenario('public-tool-pages', baseline.api['public-tool-pages'], (worker, iteration) => ({
        path:
          (worker + iteration) % 2 === 0
            ? '/tools/domain-search?q=wanmi.net'
            : '/tools/idn?q=wanmi.net',
        traceId: `perf-pages-${token}-${worker}-${iteration}`,
      })),
    () =>
      loadScenario('domain-search', baseline.api['domain-search'], (worker, iteration) => ({
        body: { query: `perf${token}${Math.max(worker, 0)}${iteration}.com` },
        expectedStates: ['ready'],
        path: '/api/v1/tools/domain-search',
        traceId: `perf-domain-${token}-${worker}-${iteration}`,
      })),
    () =>
      loadScenario('idn', baseline.api.idn, (worker, iteration, measurementRound) => ({
        body: {
          query: `perf-${token}-${Math.max(measurementRound, 0)}-${Math.max(worker, 0)}-${iteration}.com`,
        },
        expectedStates: ['ready'],
        path: '/api/v1/tools/idn',
        traceId: `perf-idn-${token}-${measurementRound}-${worker}-${iteration}`,
      })),
  ])
}

async function launchChrome() {
  const port = await availablePort()
  const profile = await mkdtemp(path.join(tmpdir(), 'wanmi-lighthouse-'))
  const chromePath =
    process.env.PERFORMANCE_CHROME_PATH ??
    (process.platform === 'darwin' ? Launcher.getFirstInstallation() : undefined) ??
    chromium.executablePath()
  const instance = await launch({
    chromeFlags: ['--headless', '--no-sandbox'],
    chromePath,
    port,
    userDataDir: profile,
  })
  return { instance, port: instance.port, profile }
}

async function lighthouseRun(page, port, runLabel) {
  let result
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = await withTimeout(
      lighthouse(new URL(page.path, baseUrl).toString(), {
        disableStorageReset: false,
        formFactor: 'desktop',
        logLevel: 'error',
        maxWaitForLoad: 35_000,
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
      }),
      60_000,
      `Lighthouse ${page.name} ${runLabel}`,
    )
    if (!result) throw new Error(`Lighthouse returned no result for ${page.name}`)
    if (result.lhr.runtimeError) {
      if (result.lhr.runtimeError.code === 'NO_NAVSTART' && attempt === 1) {
        console.warn(`Lighthouse ${page.name} ${runLabel} retrying after NO_NAVSTART`)
        continue
      }
      throw new Error(
        `Lighthouse ${page.name} ${runLabel} failed: ${result.lhr.runtimeError.code}: ${result.lhr.runtimeError.message}`,
      )
    }
    break
  }
  if (!result || result.lhr.runtimeError) {
    throw new Error(`Lighthouse ${page.name} ${runLabel} exhausted retries`)
  }
  const measurements = {
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
  }
  const invalidMeasurements = Object.entries(measurements)
    .filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value))
    .map(([name]) => name)
  if (invalidMeasurements.length > 0) {
    throw new Error(
      `Lighthouse ${page.name} ${runLabel} returned non-numeric metrics: ${invalidMeasurements.join(', ')}`,
    )
  }
  return measurements
}

async function lighthousePage(page, port) {
  const runs = []
  for (let run = 0; run < baseline.lighthouse.runs; run += 1) {
    runs.push(await lighthouseRun(page, port, `run ${run + 1}`))
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
  const pages = await runWarmupThenMeasurements(
    () => lighthouseRun(baseline.lighthouse.pages[0], chrome.port, 'warmup'),
    baseline.lighthouse.pages.map((page) => () => lighthousePage(page, chrome.port)),
  )
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
    await withTimeout(chrome.instance.kill(), 7_000, 'Chrome shutdown')
    await rm(chrome.profile, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
  }
  if (web) await stopChild(web)
}
