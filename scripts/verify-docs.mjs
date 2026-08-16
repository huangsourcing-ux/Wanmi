import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

import { check, format, resolveConfig } from 'prettier'

const repository = process.cwd()
const configuredBase = process.env.VALIDATION_DIFF_BASE_SHA?.trim()
const configuredHead = process.env.VALIDATION_DIFF_HEAD_SHA?.trim()

function runGit(args, options = {}) {
  return spawnSync('git', args, { cwd: repository, ...options })
}

function resolveDiff() {
  if (Boolean(configuredBase) !== Boolean(configuredHead)) {
    throw new Error('VALIDATION_DIFF_BASE_SHA and VALIDATION_DIFF_HEAD_SHA must be set together')
  }

  if (configuredBase && configuredHead) {
    for (const revision of [configuredBase, configuredHead]) {
      if (runGit(['cat-file', '-e', `${revision}^{commit}`], { stdio: 'ignore' }).status !== 0) {
        throw new Error(`Unable to resolve validation commit ${revision}`)
      }
    }
    return {
      base: configuredBase,
      diffArgs: [configuredBase, configuredHead],
      includeUntracked: false,
    }
  }

  const mergeBase = runGit(['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' })
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    throw new Error('Unable to determine the local validation base')
  }
  return {
    base: mergeBase.stdout.trim(),
    diffArgs: [mergeBase.stdout.trim()],
    includeUntracked: true,
  }
}

function changedPaths({ diffArgs, includeUntracked }) {
  const tracked = runGit(['diff', '--no-renames', '--name-only', '-z', ...diffArgs, '--'])
  if (tracked.status !== 0) throw new Error('Unable to enumerate changed documentation')

  const paths = tracked.stdout.toString('utf8').split('\0').filter(Boolean)
  if (!includeUntracked) return paths

  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'])
  if (untracked.status !== 0) throw new Error('Unable to enumerate untracked documentation')
  return [...new Set([...paths, ...untracked.stdout.toString('utf8').split('\0').filter(Boolean)])]
}

function verifyDiffCheck({ diffArgs, includeUntracked }, paths) {
  const result = runGit(['diff', '--check', ...diffArgs, '--'], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error('git diff --check failed')
  }

  if (!includeUntracked) return
  for (const path of paths) {
    const tracked = runGit(['ls-files', '--error-unmatch', '--', path], { stdio: 'ignore' })
    if (tracked.status === 0) continue
    const untrackedCheck = runGit(['diff', '--no-index', '--check', '--', '/dev/null', path], {
      encoding: 'utf8',
    })
    if (untrackedCheck.stdout || untrackedCheck.stderr) {
      process.stderr.write(untrackedCheck.stdout)
      process.stderr.write(untrackedCheck.stderr)
      throw new Error(`Whitespace errors found in untracked file ${path}`)
    }
  }
}

function baseContent(base, path) {
  const result = runGit(['show', `${base}:${path}`])
  return result.status === 0 ? result.stdout.toString('utf8') : undefined
}

function verifyMarkdownStructure(path, source) {
  const fenceCount = source.split('\n').filter((line) => /^\s*```/u.test(line)).length
  if (fenceCount % 2 !== 0) throw new Error(`${path} has an unclosed fenced code block`)

  const linkPattern = /\]\(([^)]+)\)/gu
  for (const match of source.matchAll(linkPattern)) {
    const rawTarget = match[1]
      .trim()
      .replace(/^<|>$/gu, '')
      .split(/\s+["']/u, 1)[0]
    if (
      !rawTarget ||
      rawTarget.startsWith('#') ||
      rawTarget.startsWith('/') ||
      /^[a-z][a-z\d+.-]*:/iu.test(rawTarget)
    ) {
      continue
    }
    const decodedTarget = decodeURIComponent(rawTarget.split('#', 1)[0])
    const target = resolve(repository, dirname(path), decodedTarget)
    if (!target.startsWith(`${repository}${sep}`) || !existsSync(target)) {
      throw new Error(`${path} contains a missing local Markdown link: ${rawTarget}`)
    }
  }
}

async function verifyMarkdown(base, paths) {
  const markdownPaths = paths.filter(
    (path) => path.endsWith('.md') && existsSync(resolve(repository, path)),
  )
  const legacyFormatting = []

  for (const path of markdownPaths) {
    const absolutePath = resolve(repository, path)
    if (!absolutePath.startsWith(`${repository}${sep}`)) {
      throw new Error(`Refusing to inspect Markdown outside the repository: ${path}`)
    }

    const source = readFileSync(absolutePath, 'utf8')
    verifyMarkdownStructure(path, source)
    const prettierOptions = { ...((await resolveConfig(absolutePath)) ?? {}), filepath: path }
    await format(source, prettierOptions)
    const currentIsFormatted = await check(source, prettierOptions)
    if (currentIsFormatted) continue

    const previous = baseContent(base, path)
    const previousWasFormatted =
      previous === undefined ? true : await check(previous, prettierOptions)
    if (previousWasFormatted) {
      throw new Error(`${path} introduced new Prettier drift`)
    }
    legacyFormatting.push(path)
  }

  if (legacyFormatting.length > 0) {
    console.warn(
      `Prettier parsed ${legacyFormatting.length} changed legacy Markdown file(s) with pre-existing drift: ${legacyFormatting.join(', ')}`,
    )
  }
  console.log(`Markdown validation passed for ${markdownPaths.length} changed file(s).`)
}

try {
  const diff = resolveDiff()
  const paths = changedPaths(diff)
  verifyDiffCheck(diff, paths)
  await verifyMarkdown(diff.base, paths)
  console.log(`Diff validation passed for ${paths.length} changed path(s).`)
} catch (error) {
  console.error(
    `Documentation validation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  )
  process.exitCode = 1
}
