import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const rendererFiles = [...new Bun.Glob('src/renderer/**/*.{css,svelte,ts}').scanSync('.')]

describe('typeface and letter-spacing standard', () => {
  test('uses SF Pro first with scaled global tracking and explicit optical exceptions', () => {
    const css = readFileSync('src/renderer/index.css', 'utf8')

    expect(css).toContain("--solus-font-family: 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Inter'")
    expect(css).toMatch(/html, body, #root \{[\s\S]*?letter-spacing: -0\.0115em;/)
    expect(css).toMatch(/:where\(\.uppercase\) \{\s*letter-spacing: 0\.09em;/)
    expect(css).toMatch(/:where\(code, pre, \.font-mono\) \{\s*letter-spacing: normal;/)
  })

  test('keeps component typography on regular and medium weights', () => {
    for (const file of rendererFiles) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/font-(?:semibold|bold|\[(?:[3-9]\d{2})\])/)
      expect(source, file).not.toMatch(/font-weight:\s*(?:300|[6-9]\d{2}|bold)(?!\s+\d)/)
    }
  })

  test('centralizes UI tracking while preserving code and diff metrics', () => {
    const filesWithTracking = rendererFiles.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return /tracking-|letter-spacing/.test(source)
    })

    expect(filesWithTracking.sort()).toEqual([
      'src/renderer/components/diff/lib/diff-file-tree.ts',
      'src/renderer/index.css',
      'src/renderer/lib/diffTheme.ts',
    ])
  })
})
