import { afterEach, describe, expect, test } from 'bun:test'
import { buildSandboxThemeStyle } from '../../packages/workspace-ui/src/lib/artifactSandbox'

const previousDocument = globalThis.document
const previousGetComputedStyle = globalThis.getComputedStyle

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: previousGetComputedStyle })
})

function themeStyle(isDark: boolean): string {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {} },
  })
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({
      getPropertyValue: (name: string) =>
        name === '--solus-container-bg' ? (isDark ? '#262522' : '#fefefc') : '',
    }),
  })
  return buildSandboxThemeStyle(isDark)
}

describe('artifact sandbox theme', () => {
  test('paints the iframe document canvas with the dark workspace surface', () => {
    // WHY: a transparent iframe root falls back to a white browser canvas.
    // Dark palette values then render on white and lose contrast, even though
    // the artifact correctly used the injected Solus variables.
    const style = themeStyle(true)

    expect(style).toContain(':root{color-scheme:dark;--solus-container-bg:#262522}')
    expect(style).toContain('html{margin:0;background:var(--solus-container-bg,Canvas)')
    expect(style).toContain('body{margin:0;background:transparent')
    expect(style).not.toContain('html,body{margin:0;background:transparent')
  })

  test('uses the same canvas rule with the light workspace palette', () => {
    const style = themeStyle(false)

    expect(style).toContain(':root{color-scheme:light;--solus-container-bg:#fefefc}')
    expect(style).toContain('background:var(--solus-container-bg,Canvas)')
  })
})
