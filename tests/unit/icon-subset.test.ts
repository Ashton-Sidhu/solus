import { describe, expect, test } from 'bun:test'
import { buildLocalIconSubset } from '../../scripts/vite-icon-collections'
import { CURATED_ICONIFY_NAMES } from '../../src/renderer/components/diagram/diagram-icons'
import { FILE_TYPE_ICON_NAMES, fileTypeIcon } from '../../src/renderer/lib/fileTypeIcon'

describe('file type icons', () => {
  test('selects distinct icons for autocomplete file rows', () => {
    // WHY: autocomplete file results should be visually scannable by type,
    // while directories and unknown extensions retain the generic SVG glyph.
    expect(fileTypeIcon('src/App.svelte')).toBe('logos:svelte-icon')
    expect(fileTypeIcon('src/App.tsx')).toBe('logos:react')
    expect(fileTypeIcon('scripts/release.py')).toBe('logos:python')
    expect(fileTypeIcon('src/components')).toBeNull()
    expect(fileTypeIcon('notes.unknown')).toBeNull()
  })
})

describe('local Iconify subset', () => {
  test('contains every built-in file and diagram icon without full collections', () => {
    const icons = buildLocalIconSubset()
    const names = new Set(icons.map((icon) => icon.name))
    for (const name of [...FILE_TYPE_ICON_NAMES, ...CURATED_ICONIFY_NAMES]) {
      expect(names.has(name)).toBe(true)
    }
    expect(Buffer.byteLength(JSON.stringify(icons))).toBeLessThan(250_000)
  })
})
