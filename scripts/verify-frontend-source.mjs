import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FRONTEND_SOURCE_GLOBALS_CSS,
  FRONTEND_SOURCE_MIRRORS,
  FRONTEND_STYLES_CSS,
  listFilesRecursively,
  repositoryRoot,
} from './frontend-source-paths.mjs'

/**
 * Gate: apps/web must carry the owner's frontend baseline byte for byte.
 *
 * 1. Every mirrored path has exactly the same file set as frontend-source/ and every
 *    file is byte-identical (an extra file, a missing file or a single differing byte
 *    fails the gate and is listed).
 * 2. The frontend stylesheet contains, verbatim, the blocks from the baseline
 *    globals.css that the vendored components depend on: both @font-face rules, the
 *    whole `@layer components` block and the two dyna keyframes.
 */
const BLOCK_MARKERS = [
  '@font-face',
  '@layer components',
  '@keyframes dyna-breathe',
  '@keyframes dyna-marquee',
]

/** Returns every top-level CSS block starting with `marker`, braces balanced, verbatim. */
export function extractCssBlocks(css, marker) {
  const blocks = []
  let searchFrom = 0
  for (;;) {
    const start = css.indexOf(marker, searchFrom)
    if (start === -1) return blocks
    const open = css.indexOf('{', start)
    if (open === -1) return blocks
    let depth = 0
    let index = open
    for (; index < css.length; index += 1) {
      if (css.startsWith('/*', index)) {
        const close = css.indexOf('*/', index + 2)
        index = close === -1 ? css.length : close + 1
        continue
      }
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth !== 0) throw new Error(`Unbalanced braces after ${marker} at offset ${start}`)
    blocks.push(css.slice(start, index + 1))
    searchFrom = index + 1
  }
}

function compareMirror({ source, target }) {
  const sourceRoot = path.join(repositoryRoot, source)
  const targetRoot = path.join(repositoryRoot, target)
  const sourceFiles = listFilesRecursively(sourceRoot)
  const targetFiles = listFilesRecursively(targetRoot)
  const problems = []
  if (sourceFiles.length === 0) problems.push(`baseline missing: ${source}`)

  const targetSet = new Set(targetFiles)
  const sourceSet = new Set(sourceFiles)
  const join = (root, relative) => (relative === '' ? root : path.join(root, relative))
  const show = (base, relative) => (relative === '' ? base : `${base}/${relative}`)

  for (const relative of sourceFiles) {
    if (!targetSet.has(relative)) {
      problems.push(`missing in target: ${show(target, relative)}`)
      continue
    }
    const expected = readFileSync(join(sourceRoot, relative))
    const actual = readFileSync(join(targetRoot, relative))
    if (!expected.equals(actual)) {
      problems.push(
        `differs: ${show(target, relative)} (${actual.length} bytes) vs ${show(source, relative)} (${expected.length} bytes)`,
      )
    }
  }
  for (const relative of targetFiles) {
    if (!sourceSet.has(relative)) problems.push(`extra in target: ${show(target, relative)}`)
  }
  return { compared: sourceFiles.length, problems }
}

function compareStylesheetBlocks() {
  const globals = readFileSync(path.join(repositoryRoot, FRONTEND_SOURCE_GLOBALS_CSS), 'utf8')
  const styles = readFileSync(path.join(repositoryRoot, FRONTEND_STYLES_CSS), 'utf8')
  const problems = []
  let checked = 0
  for (const marker of BLOCK_MARKERS) {
    const blocks = extractCssBlocks(globals, marker)
    if (blocks.length === 0) {
      problems.push(`${FRONTEND_SOURCE_GLOBALS_CSS} has no ${marker} block`)
      continue
    }
    for (const [index, block] of blocks.entries()) {
      checked += 1
      if (!styles.includes(block)) {
        const label = blocks.length > 1 ? `${marker} #${index + 1}` : marker
        problems.push(
          `${FRONTEND_STYLES_CSS} does not contain ${label} verbatim (${block.length} chars)`,
        )
      }
    }
  }
  return { checked, problems }
}

export function verifyFrontendSource() {
  const mirrors = FRONTEND_SOURCE_MIRRORS.map((mirror) => ({ ...mirror, ...compareMirror(mirror) }))
  const stylesheet = compareStylesheetBlocks()
  return {
    compared: mirrors.reduce((total, mirror) => total + mirror.compared, 0),
    cssBlocks: stylesheet.checked,
    problems: [...mirrors.flatMap((mirror) => mirror.problems), ...stylesheet.problems],
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = verifyFrontendSource()
  if (result.problems.length > 0) {
    console.error(`verify:frontend-source FAILED (${result.problems.length} problem(s)):`)
    for (const problem of result.problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log(
    `verify:frontend-source OK: ${result.compared} mirrored files byte-identical, ${result.cssBlocks} CSS blocks present verbatim`,
  )
}
