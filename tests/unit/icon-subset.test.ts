import { describe, expect, test } from 'bun:test'
import { buildLocalIconSubset } from '../../scripts/vite-icon-collections'
import { CURATED_ICONIFY_NAMES } from '../../src/renderer/components/diagram/diagram-icons'
import { FILE_TYPE_ICON_NAMES } from '../../src/renderer/lib/fileTypeIcon'

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
