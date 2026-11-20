import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { matchesSearch } from '@solus/workspace-ui/lib/search-match'

const repoRoot = join(import.meta.dir, '../..')
const scannedRoots = ['packages/workspace-ui/src', 'apps/client/src', 'apps/desktop/src']
// The primitive's own wrapper passes every prop through.
const wrapper = 'packages/workspace-ui/src/components/ui/command/command.svelte'

function svelteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : svelteFiles(path)
    return entry.name.endsWith('.svelte') ? [path] : []
  })
}

/** The opening tag that starts at `start`, up to the `>` outside any `{…}` or quotes. */
function openingTag(source: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
    } else if (char === '>' && depth === 0) {
      return source.slice(start, index + 1)
    }
  }
  return source.slice(start)
}

describe('list menu search', () => {
  test('every command menu filters its own rows', () => {
    // WHY: the command menu's own filter sorts rows by moving their DOM nodes.
    // A keyed list that also changes with the search loses track of the moved
    // nodes, and rows from an earlier search stay on screen: "portable-session"
    // showed "deps/sec-postcss" above the branch it named.
    const offenders: string[] = []
    for (const root of scannedRoots) {
      for (const file of svelteFiles(join(repoRoot, root))) {
        const path = relative(repoRoot, file)
        if (path === wrapper) continue
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(/<(Command|CommandPrimitive)\.Root\b/g)) {
          if (!openingTag(source, match.index).includes('shouldFilter={false}')) offenders.push(path)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('a row matches when its label holds every word of the search', () => {
    // WHY: a fuzzy match ranked unrelated rows first. A word match lists only
    // rows that name what was typed, in any order.
    expect(matchesSearch('solus/verify-portable-session-cli', 'portable-session')).toBe(true)
    expect(matchesSearch('deps/sec-postcss', 'portable-session')).toBe(false)
    expect(matchesSearch('team/feature-4999', 'Team 4999')).toBe(true)
    expect(matchesSearch('main', '')).toBe(true)
  })
})
