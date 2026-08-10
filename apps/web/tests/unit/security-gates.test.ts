import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repository = resolve(process.cwd(), '../..')

function source(path: string): string {
  return readFileSync(resolve(repository, path), 'utf8')
}

function routeFiles(directory: string): string[] {
  return readdirSync(resolve(repository, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return routeFiles(path)
    return entry.name === 'route.ts' ? [path] : []
  })
}

describe('D7 repository security gates', () => {
  it('scans complete git history without the worktree-only exclusions', () => {
    const security = source('scripts/security.mjs')
    const historyConfigArgument = security.indexOf("'--config=/repo/.gitleaks-history.toml'")
    const history = security.slice(historyConfigArgument - 400, historyConfigArgument + 400)
    const historyConfig = source('.gitleaks-history.toml')

    expect(security).toContain("'--config=/repo/.gitleaks-history.toml'")
    expect(history).not.toContain("'--no-git'")
    expect(historyConfig).not.toContain('.env.local')
  })

  it('keeps provider-secret assignments on one line so empty placeholders stay valid', () => {
    const expectedAssignmentWhitespace = String.raw`[ \t]*=[ \t]*`
    const crossLineAssignmentWhitespace = String.raw`\s*=\s*`
    const example = source('.env.example')

    for (const configPath of ['.gitleaks.toml', '.gitleaks-history.toml']) {
      const config = source(configPath)
      expect(config).toContain(expectedAssignmentWhitespace)
      expect(config).not.toContain(crossLineAssignmentWhitespace)
    }

    for (const key of ['WESTDIGITAL_API_PASSWORD', 'WECHATPAY_API_V3_KEY']) {
      expect(example).toContain(`# ${key}=`)
    }
    expect(example).toContain('# WECHATPAY_MERCHANT_PRIVATE_KEY_PATH=')
  })

  it('fails the linux/amd64 image scan on HIGH or CRITICAL findings', () => {
    const dockerfile = source('apps/web/Dockerfile')
    const makefile = source('Makefile')
    const security = source('scripts/security.mjs')
    expect(makefile).toContain('docker build --platform linux/amd64')
    expect(makefile).toMatch(/^security: build$/mu)
    expect(security).toContain("'--severity',\n    'HIGH,CRITICAL'")
    expect(security).toContain('unapprovedFindings.push(finding)')
    expect(security).toContain('failed = true')
    expect(security).toContain("'wanmi-web:d0'")
    expect(security).toContain('aquasec/trivy:0.73.0@sha256:')
    expect(dockerfile).toContain(
      'node:24.19.0-alpine3.24@sha256:2a49bdf71e9fd965a58c1703fd9ddd205b34e5782b692a72dd1d248abb0beb43',
    )
    expect(dockerfile).toContain(
      'pnpm --filter @wanmi/web deploy --prod --legacy --offline /runtime',
    )
    expect(dockerfile).toContain('COPY --from=builder --chown=wanmi:wanmi /runtime /app')
    expect(dockerfile).toContain('/usr/local/lib/node_modules/npm')
    expect(dockerfile).not.toContain('COPY --from=builder --chown=wanmi:wanmi /app /app')
  })

  it('keeps image-size exceptions exact, package-scoped, and justified', () => {
    const security = source('scripts/security.mjs')
    expect(security.match(/id: 'GHSA-/gu)).toHaveLength(2)
    expect(security).toContain("id: 'GHSA-w3rx-r6r6-pgpr'")
    expect(security).toContain("id: 'GHSA-5p2g-fcmc-qvqq'")
    expect(security.match(/packageName: 'image-size'/gu)).toHaveLength(2)
    expect(security.match(/version: '2\.0\.2'/gu)).toHaveLength(2)
    expect(security.match(/reason:/gu)).toHaveLength(2)
    expect(security).toContain('vendorIds.includes(id)')
  })

  it('keeps every privileged admin business route behind the shared system-admin guard', () => {
    const publicOrSelfServiceAuthRoutes = new Set([
      'apps/web/src/app/api/v1/admin/auth/invitations/accept/route.ts',
      'apps/web/src/app/api/v1/admin/auth/invitations/resolve/route.ts',
      'apps/web/src/app/api/v1/admin/auth/login/route.ts',
      'apps/web/src/app/api/v1/admin/auth/logout/route.ts',
    ])
    const protectedRoutes = routeFiles('apps/web/src/app/api/v1/admin').filter(
      (path) => !publicOrSelfServiceAuthRoutes.has(path),
    )

    expect(protectedRoutes.length).toBeGreaterThan(0)
    for (const path of protectedRoutes) {
      expect(source(path), path).toContain('systemAdminRequest')
    }
  })
})
