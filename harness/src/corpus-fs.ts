import { readdirSync } from 'node:fs'

/**
 * Case directories inside a corpus split, sorted.
 *
 * Filters to real directories and drops dot-entries. Both matter: macOS drops
 * `.DS_Store` into any directory the Finder touches, and a walker that assumes
 * every entry is a case dies with an unhelpful ENOTDIR on a path nobody
 * created deliberately.
 */
export function listCaseDirs(splitDir: string): string[] {
  return readdirSync(splitDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}
