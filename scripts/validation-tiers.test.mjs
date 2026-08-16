import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyChangedPaths, validationScopes } from './ci-validation-scope.mjs'
import { securityPlanForArgs } from './security-plan.mjs'

test('classifies an all-Markdown diff as documentation-only', () => {
  assert.equal(
    classifyChangedPaths(['AGENTS.md', 'docs/operations/release-rollback.md']),
    validationScopes.docs,
  )
})

test('fails closed when Markdown is mixed with application code', () => {
  assert.equal(
    classifyChangedPaths(['开发日志.md', 'apps/web/src/services/auth/otp.ts']),
    validationScopes.full,
  )
})

test('fails closed when Markdown is mixed with a migration', () => {
  assert.equal(
    classifyChangedPaths([
      '开发日志.md',
      'apps/web/migrations/20260816_120000_validation_policy.ts',
    ]),
    validationScopes.full,
  )
})

test('fails closed when Markdown is mixed with a deploy manifest', () => {
  assert.equal(
    classifyChangedPaths(['README.md', 'deploy/release-manifest.json']),
    validationScopes.full,
  )
})

test('fails closed for empty, absolute, parent-relative, or non-lowercase Markdown paths', () => {
  assert.equal(classifyChangedPaths([]), validationScopes.full)
  assert.equal(classifyChangedPaths(['/tmp/README.md']), validationScopes.full)
  assert.equal(classifyChangedPaths(['../README.md']), validationScopes.full)
  assert.equal(classifyChangedPaths(['README.MD']), validationScopes.full)
})

test('keeps the default security plan complete and secrets-only mode isolated', () => {
  assert.deepEqual(securityPlanForArgs([]), {
    dependencyAudit: true,
    imageScan: true,
    secretScan: true,
  })
  assert.deepEqual(securityPlanForArgs(['--secrets-only']), {
    dependencyAudit: false,
    imageScan: false,
    secretScan: true,
  })
  assert.throws(() => securityPlanForArgs(['--unknown']))
})

test('keeps required CI always triggered and routes both scopes through the same check job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /paths-ignore/u)
  assert.match(workflow, /^  check:\n/mu)
  assert.match(workflow, /make check-docs/u)
  assert.match(workflow, /make check/u)
  assert.match(workflow, /scope=full/u)
  assert.match(
    workflow,
    /DATABASE_URL: postgresql:\/\/wanmi:wanmi_local_only@127\.0\.0\.1:55432\/wanmi/u,
  )
  assert.match(
    makefile,
    /test-integration:\n\tdocker compose up -d postgres whodat minio minio-init\n\tdocker compose up -d --wait --wait-timeout 60 postgres whodat minio/u,
  )
})
