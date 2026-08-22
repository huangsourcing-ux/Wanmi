import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Owner-maintained frontend baseline (frontend-source/) and the apps/web paths that
 * must mirror it byte-for-byte. Same relative layout on both sides, so the vendored
 * components keep every import untouched. Only the owner changes frontend-source/.
 */
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const FRONTEND_SOURCE_ROOT = 'frontend-source'

export const FRONTEND_SOURCE_MIRRORS = Object.freeze([
  {
    source: 'frontend-source/src/components/sites',
    target: 'apps/web/src/components/sites',
  },
  {
    source: 'frontend-source/src/types/dynadot.ts',
    target: 'apps/web/src/types/dynadot.ts',
  },
  {
    source: 'frontend-source/public/sites',
    target: 'apps/web/public/sites',
  },
])

export const FRONTEND_SOURCE_GLOBALS_CSS = 'frontend-source/src/app/globals.css'
export const FRONTEND_STYLES_CSS = 'apps/web/src/app/(frontend)/styles.css'

/** Never part of the baseline: placeholder markers and Finder metadata. */
const IGNORED_FILE_NAMES = new Set(['.gitkeep', '.DS_Store'])

export function isIgnoredFileName(name) {
  return IGNORED_FILE_NAMES.has(name)
}

/**
 * Lists every regular file under `root` as a sorted array of POSIX-style paths
 * relative to `root`. Returns [] when `root` does not exist.
 */
export function listFilesRecursively(root) {
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    return []
  }
  if (rootStat.isFile()) return ['']

  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (isIgnoredFileName(entry.name)) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}
