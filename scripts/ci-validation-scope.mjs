import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const validationScopes = Object.freeze({
  docs: 'docs',
  full: 'full',
})

function isRepositoryRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')) return false
  const segments = path.split('/')
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..')
}

export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return validationScopes.full

  return paths.every((path) => isRepositoryRelativePath(path) && path.endsWith('.md'))
    ? validationScopes.docs
    : validationScopes.full
}

function readArgument(args, name) {
  const index = args.indexOf(name)
  if (index === -1 || index === args.length - 1) {
    throw new Error(`Missing required ${name} argument`)
  }
  return args[index + 1]
}

function assertCommit(repository, revision) {
  const result = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
    cwd: repository,
    stdio: 'ignore',
  })
  if (result.status !== 0) throw new Error(`Unable to resolve commit ${revision}`)
}

export function changedPathsBetween({ base, head, repository = process.cwd() }) {
  if (!base || !head) throw new Error('Both base and head commits are required')
  assertCommit(repository, base)
  assertCommit(repository, head)

  const result = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'], {
    cwd: repository,
  })
  if (result.status !== 0) throw new Error('Unable to enumerate changed paths')

  return result.stdout.toString('utf8').split('\0').filter(Boolean)
}

function isDirectExecution() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
}

if (isDirectExecution()) {
  try {
    const args = process.argv.slice(2)
    const base = readArgument(args, '--base')
    const head = readArgument(args, '--head')
    const paths = changedPathsBetween({ base, head })
    process.stdout.write(`${classifyChangedPaths(paths)}\n`)
  } catch (error) {
    console.error(
      `Unable to classify CI validation scope: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    process.exitCode = 1
  }
}
