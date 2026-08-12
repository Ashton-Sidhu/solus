import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { DIFFS_THEME_CSS } from '../../src/renderer/lib/diffTheme'

const roots = [
  join(import.meta.dir, '../../src/renderer'),
  join(import.meta.dir, '../../client/src'),
]

const allowedRemSizes = new Set(['0.75', '0.8125', '0.875', '1.5'])
// Pierre's gutter labels must scale with the configurable code font, not the UI type scale.
const allowedRelativeFontSizes = new Set(['0.75', '0.85', '0.95'])

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.(css|svelte|ts)$/.test(entry)) yield path
  }
}

function location(path: string, source: string, offset: number): string {
  const root = roots.find((candidate) => path.startsWith(candidate)) ?? roots[0]
  const line = source.slice(0, offset).split('\n').length
  return `${relative(root, path)}:${line}`
}

describe('renderer type scale', () => {
  test('keeps Pierre gutter labels relative to the code font size', () => {
    // WHY: Fixed rem sizes make hunk labels larger than the surrounding gutter text.
    expect(DIFFS_THEME_CSS).toContain('font-size: 0.75em;')
    expect(DIFFS_THEME_CSS).toContain('font-size: 0.85em;')
    expect(DIFFS_THEME_CSS).toContain('font-size: 0.95em;')
  })

  test('uses only the 12, 13, 14, and 24 pixel Tailwind sizes', () => {
    const offenders: string[] = []

    for (const root of roots) {
      for (const path of sourceFiles(root)) {
        const source = readFileSync(path, 'utf8')

        for (const match of source.matchAll(/\btext-(base|lg|xl|[2-9]xl)\b/g)) {
          offenders.push(`${location(path, source, match.index)} ${match[0]}`)
        }

        for (const match of source.matchAll(/text-\[(\d+(?:\.\d+)?)(rem|px)\]/g)) {
          const rem = match[2] === 'px' ? String(Number(match[1]) / 16) : match[1]
          if (!allowedRemSizes.has(rem)) {
            offenders.push(`${location(path, source, match.index)} ${match[0]}`)
          }
        }
      }
    }

    // WHY: A size outside the standard restores the density drift this removes.
    expect(offenders).toEqual([])
  })

  test('uses only the standard rem tokens in numeric font-size declarations', () => {
    const offenders: string[] = []

    for (const root of roots) {
      for (const path of sourceFiles(root)) {
        const source = readFileSync(path, 'utf8')
        const declarations = source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)(rem|px|em)/g)

        for (const match of declarations) {
          if (match[2] === 'em' && match[1] === '1') continue
          const sourcePath = relative(root, path)
          if (
            sourcePath === 'lib/diffTheme.ts' &&
            match[2] === 'em' &&
            allowedRelativeFontSizes.has(match[1])
          ) {
            continue
          }
          const rem = match[2] === 'px' ? String(Number(match[1]) / 16) : match[1]
          if (!allowedRemSizes.has(rem)) {
            offenders.push(`${location(path, source, match.index)} ${match[0]}`)
          }
        }
      }
    }

    // WHY: CSS blocks and inline styles must not bypass the shared type scale.
    expect(offenders).toEqual([])
  })
})
