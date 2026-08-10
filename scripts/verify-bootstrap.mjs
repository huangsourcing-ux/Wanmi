import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createLocalEnvironment } from './bootstrap.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wanmi-bootstrap-'))
const temporaryEnvironment = join(temporaryDirectory, '.env.local')

const isolatedEnvironment = Object.fromEntries(
  ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)

try {
  const created = await createLocalEnvironment(pathToFileURL(temporaryEnvironment))
  if (!created) throw new Error('bootstrap verification target unexpectedly existed')

  const contents = await readFile(temporaryEnvironment, 'utf8')
  if (contents.includes('replace-with-')) {
    throw new Error('bootstrap left a local secret placeholder unresolved')
  }
  if (((await stat(temporaryEnvironment)).mode & 0o777) !== 0o600) {
    throw new Error('bootstrap environment file must use mode 0600')
  }

  const validation = spawnSync(
    join(repositoryRoot, 'apps/web/node_modules/.bin/tsx'),
    [
      `--env-file=${temporaryEnvironment}`,
      join(repositoryRoot, 'apps/web/scripts/validate-environment.ts'),
    ],
    {
      cwd: join(repositoryRoot, 'apps/web'),
      env: isolatedEnvironment,
      stdio: 'inherit',
    },
  )
  if (validation.error) throw validation.error
  if (validation.status !== 0) {
    throw new Error(`bootstrap environment validation exited with status ${validation.status}`)
  }

  process.stdout.write(
    'Bootstrap verified: a clean generated .env.local passes complete getEnv validation.\n',
  )
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}
