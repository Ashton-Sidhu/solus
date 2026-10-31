import { describe, expect, test } from 'bun:test'
import { buildLocalIconSubset } from '../../scripts/vite-icon-collections'
import { CURATED_ICONIFY_NAMES } from '@solus/workspace-ui/components/diagram/diagram-icons'
import { resolveFileIcon } from '@solus/client-core/file-icons'

describe('file type icons', () => {
  test('selects distinct icons for autocomplete file rows', () => {
    // WHY: autocomplete file results should be visually scannable by type,
    // while directories and unknown extensions retain the generic SVG glyph.
    expect(resolveFileIcon('src/App.svelte').token).toBe('svelte')
    expect(resolveFileIcon('src/App.tsx').token).toBe('react')
    expect(resolveFileIcon('scripts/release.py').token).toBe('python')
    expect(resolveFileIcon('src/components/').token).toBe('folder')
    expect(resolveFileIcon('notes.unknown').token).toBe('default')
  })
})

describe('local Iconify subset', () => {
  test('contains every built-in diagram icon without full collections', () => {
    const icons = buildLocalIconSubset()
    const names = new Set(icons.map((icon) => icon.name))
    for (const name of [...CURATED_ICONIFY_NAMES]) {
      expect(names.has(name)).toBe(true)
    }
    expect(Buffer.byteLength(JSON.stringify(icons))).toBeLessThan(250_000)
  })
})
