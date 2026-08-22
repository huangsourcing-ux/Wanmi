import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  FRONTEND_SOURCE_MIRRORS,
  listFilesRecursively,
  repositoryRoot,
} from './frontend-source-paths.mjs'

/**
 * Mirrors frontend-source/ into apps/web, byte for byte. Pure copy: no formatting,
 * no text replacement, no import rewriting. Idempotent: target files that are not
 * in the baseline are removed so the two file sets stay identical (the gate in
 * verify-frontend-source.mjs rejects any extra, missing or differing file).
 */
function removeEmptyDirectories(directory, stopAt) {
  let current = directory
  while (current !== stopAt && current.startsWith(stopAt)) {
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    if (entries.length > 0) return
    rmSync(current, { recursive: false })
    current = path.dirname(current)
  }
}

function syncMirror({ source, target }) {
  const sourceRoot = path.join(repositoryRoot, source)
  const targetRoot = path.join(repositoryRoot, target)
  const sourceFiles = listFilesRecursively(sourceRoot)
  if (sourceFiles.length === 0) throw new Error(`Baseline path is missing or empty: ${source}`)

  let copied = 0
  for (const relative of sourceFiles) {
    const from = relative === '' ? sourceRoot : path.join(sourceRoot, relative)
    const to = relative === '' ? targetRoot : path.join(targetRoot, relative)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
    copied += 1
  }

  let removed = 0
  if (statSync(sourceRoot).isDirectory()) {
    const wanted = new Set(sourceFiles)
    for (const relative of listFilesRecursively(targetRoot)) {
      if (wanted.has(relative)) continue
      const stale = path.join(targetRoot, relative)
      rmSync(stale)
      removeEmptyDirectories(path.dirname(stale), targetRoot)
      removed += 1
    }
  }
  return { copied, removed, source, target }
}

const results = FRONTEND_SOURCE_MIRRORS.map(syncMirror)
for (const result of results) {
  console.log(
    `${result.source} -> ${result.target}: copied ${result.copied}, removed ${result.removed}`,
  )
}
