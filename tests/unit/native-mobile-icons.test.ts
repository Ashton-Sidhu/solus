import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'

// Native icons follow T3 Code's conventions in Solus's palette, and every SF
// Symbol the app names exists on its iOS 16.4 floor (T3 targets iOS 18, so a
// glyph copied from it could draw nothing on an older phone).

const root = join(import.meta.dir, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('native icon styling', () => {
  test('a row\'s leading glyph is T3\'s: bare, 22pt iOS / 24pt Android, icon ink, regular weight', () => {
    // T3's `SettingsControlRow` values; T3 is not part of this repository.
    const native = read('apps/mobile/src/components/RowLeadingSymbol.tsx')
    for (const rule of ['size={Platform.OS === "android" ? 24 : 22}', '"accent-icon"', 'weight="regular"']) {
      expect({ rule, present: native.includes(rule) }).toEqual({ rule, present: true })
    }
    // The mode rows use it, not the desktop menu's tinted tile.
    for (const path of ['apps/mobile/src/features/threads/ThreadSettingsRows.tsx', 'apps/mobile/src/features/settings/components/SettingsChoiceRow.tsx']) {
      const source = read(path)
      expect(source).toContain('<RowLeadingSymbol name={props.icon} />')
      expect(source).not.toContain('size-8 shrink-0 items-center justify-center rounded-lg bg-subtle')
    }
  })

  test('every SF Symbol the native app names exists in SF Symbols 4 (iOS 16.4)', () => {
    const symbols = read('node_modules/sf-symbols-typescript/dist/index.d.ts')
    const introduced = new Map<string, number>()
    for (const block of symbols.split('export type SFSymbols').slice(1)) {
      const major = Number(block.slice(0, block.indexOf('_')))
      for (const match of block.matchAll(/\| '([^']+)'/g)) if (!introduced.has(match[1]!)) introduced.set(match[1]!, major)
    }
    const late: string[] = []
    for (const path of new Glob('apps/mobile/src/**/*.{ts,tsx}').scanSync(root)) {
      // Dotted names only: a bare word (`left`, `document`) is as often a layout or kind string.
      for (const match of read(path).matchAll(/["']([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)["']/g)) {
        const major = introduced.get(match[1]!)
        if (major !== undefined && major >= 5) late.push(`${match[1]} (SF ${major}) in ${path}`)
      }
    }
    expect(late).toEqual([])
  })
})
