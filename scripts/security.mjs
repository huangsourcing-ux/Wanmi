import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const repository = process.cwd()
let failed = false

function runCheck(check) {
  console.log(`Running ${check.name}...`)
  const result = spawnSync(check.command, check.args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
    console.error(`${check.name} failed with status ${result.status ?? 'unknown'}`)
  }
}

runCheck({
  command: 'pnpm',
  args: ['audit', '--prod', '--audit-level', 'high'],
  name: 'dependency audit',
})

const gitFiles = spawnSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: repository },
)
if (gitFiles.status !== 0) {
  throw new Error('Unable to enumerate repository-visible files for secret scanning')
}

const temporaryPrefix = join(tmpdir(), 'wanmi-gitleaks-')
const scanRoot = mkdtempSync(temporaryPrefix)

try {
  for (const relativePath of gitFiles.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const source = resolve(repository, relativePath)
    const destination = resolve(scanRoot, relativePath)
    if (!source.startsWith(`${repository}${sep}`) || !destination.startsWith(`${scanRoot}${sep}`)) {
      throw new Error(`Refusing to scan path outside repository: ${relativePath}`)
    }

    mkdirSync(dirname(destination), { recursive: true })
    const metadata = lstatSync(source)
    if (metadata.isFile()) copyFileSync(source, destination)
    if (metadata.isSymbolicLink()) writeFileSync(destination, readlinkSync(source))
  }

  runCheck({
    command: 'docker',
    args: [
      'run',
      '--rm',
      '-v',
      `${scanRoot}:/repo:ro`,
      'ghcr.io/gitleaks/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9',
      'detect',
      '--no-banner',
      '--no-git',
      '--redact',
      '--verbose',
      '--config=/repo/.gitleaks.toml',
      '--source=/repo',
    ],
    name: 'secret scan',
  })
} finally {
  if (!scanRoot.startsWith(temporaryPrefix)) {
    throw new Error('Refusing to remove unexpected secret-scan directory')
  }
  rmSync(scanRoot, { recursive: true })
}

process.exit(failed ? 1 : 0)
