import { readdir, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { FileMatch } from '@solus/contracts/types'
import { expandHome } from './host-path'

/** Explicit paths are shallow browsing, never recursive search or watches.
 * null means a plain query which the project index should answer. */
export async function browseFileMatches(query: string, cwd: string): Promise<FileMatch[] | null> {
  const isPath = isAbsolute(query) || query === '~' || query.startsWith('~/')
    || query.startsWith('./') || query.startsWith('../')
  if (query && !isPath) return null

  const root = resolve(expandHome(cwd))
  const target = query ? resolve(root, query.startsWith('~') ? expandHome(query) : query) : root
  const isDirectory = await stat(target).then(value => value.isDirectory()).catch(() => false)
  if (!isDirectory && (!query || query.endsWith(sep))) return []
  const directory = isDirectory ? target : dirname(target)
  const needle = isDirectory ? '' : basename(target).toLocaleLowerCase()
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => !entry.name.startsWith('.') && entry.name.toLocaleLowerCase().includes(needle))
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory())
      || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
    .map(entry => {
      const path = join(directory, entry.name)
      const rel = relative(root, path)
      const display = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
      return { path, display, isDir: entry.isDirectory() }
    })
}
