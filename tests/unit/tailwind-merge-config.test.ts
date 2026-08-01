import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cn, tv } from '../../src/renderer/lib/tw'

const RENDERER = join(import.meta.dir, '../../src/renderer')
const THEME_CSS = readFileSync(join(RENDERER, 'index.css'), 'utf8')

/**
 * Every custom `@theme` key becomes a utility class, but tailwind-merge only
 * knows Tailwind's stock scales — an unregistered key gets misclassified and
 * silently deleted when a same-prefix class follows it. The style then vanishes
 * from the DOM with no warning and no build error. `text-menu` was read as a
 * colour and dropped against `text-(--solus-text-secondary)` on every menu row,
 * leaving rows with no font-size at all.
 *
 * Register new keys in `src/renderer/lib/tw.ts`; these tests hold the line.
 */
const customFontSizes = [...THEME_CSS.matchAll(/^\s*--text-([\w-]+):/gm)]
  .map(([, key]) => `text-${key}`)
  // Tailwind's own scale is already known to tailwind-merge.
  .filter((cls) => !/^text-(xs|sm|base|lg|xl|\d?xl)$/.test(cls))

describe('custom @theme font sizes survive class merging', () => {
  test('index.css defines custom font-size keys worth guarding', () => {
    expect(customFontSizes.length).toBeGreaterThan(0)
  })

  test.each(customFontSizes)('cn() keeps %s beside a colour class', (cls: string) => {
    expect(cn(cls, 'text-(--solus-text-secondary)').split(' ')).toContain(cls)
  })

  // tailwind-variants bundles a *separate* tailwind-merge instance, so a config
  // that fixes `cn` leaves `tv` broken. Both paths need the same guard.
  test.each(customFontSizes)('tv() keeps %s beside a colour class', (cls: string) => {
    expect(tv({ base: `${cls} text-(--solus-text-secondary)` })().split(' ')).toContain(cls)
  })

  test('a later size still overrides an earlier one', () => {
    expect(cn('text-menu', 'text-menu-meta')).toBe('text-menu-meta')
  })
})

/**
 * Same failure mode one prefix over: an unregistered `--font-weight-*` key
 * reads as a font-*family* to tailwind-merge (a bare word after `font-` is a
 * family unless it is in the stock weight scale), so `font-secondary` deletes
 * the `font-sans` beside it and the element loses its typeface.
 */
const customFontWeights = [...THEME_CSS.matchAll(/^\s*--font-weight-([\w-]+):/gm)]
  .map(([, key]) => `font-${key}`)
  // Tailwind's own scale is already known to tailwind-merge.
  .filter(
    (cls) =>
      !/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(cls),
  )

describe('custom @theme font weights survive class merging', () => {
  test('index.css defines custom font-weight keys worth guarding', () => {
    expect(customFontWeights.length).toBeGreaterThan(0)
  })

  test.each(customFontWeights)('cn() keeps %s beside a family class', (cls: string) => {
    expect(cn('font-sans', cls).split(' ')).toContain('font-sans')
  })

  test.each(customFontWeights)('tv() keeps %s beside a family class', (cls: string) => {
    expect(tv({ base: `font-sans ${cls}` })().split(' ')).toContain('font-sans')
  })

  test('a later weight still overrides an earlier one', () => {
    expect(cn('font-secondary', 'font-semibold')).toBe('font-semibold')
    expect(cn('font-semibold', 'font-secondary')).toBe('font-secondary')
  })
})

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.(svelte|ts)$/.test(entry)) yield path
  }
}

/**
 * shadcn-svelte generates `import { tv } from "tailwind-variants"` every time a
 * variant-based primitive is added (`button`, `toggle`, `tabs`, …), which
 * reopens the hole above with an unconfigured merge instance. With no linter in
 * the project, this test is the no-restricted-imports rule.
 */
test('nothing imports tv straight from tailwind-variants', () => {
  const offenders = [...sourceFiles(RENDERER)]
    .filter(
      (path) =>
        path !== join(RENDERER, 'lib/tw.ts') &&
        /from\s+['"]tailwind-variants['"]/.test(readFileSync(path, 'utf8')),
    )
    .map((path) => path.slice(RENDERER.length + 1))

  expect(offenders).toEqual([])
})
