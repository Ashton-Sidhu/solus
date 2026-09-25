import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// WHY: Solus renders one density on every display. A person who wants a
// denser or roomier UI zooms (mod+plus / mod+minus) — the app never guesses
// from the monitor. The old laptop tier keyed type and geometry on
// `screen.width`, so a phone, a tablet and a 14" MacBook all took a second,
// smaller layout that outranked touch and container rungs. This test fails if
// a display-size class comes back.

const UI_ROOT = join(import.meta.dir, '../../packages/workspace-ui/src')

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(svelte|ts|css)$/.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}

describe('single density', () => {
  test('no workspace UI source sizes itself by the display', async () => {
    const offenders: string[] = []
    for (const path of await sourceFiles(UI_ROOT)) {
      if ((await readFile(path, 'utf8')).includes('is-laptop-display')) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
