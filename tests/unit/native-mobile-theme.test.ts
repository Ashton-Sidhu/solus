import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMobileThemeVariables } from '../../apps/mobile/src/lib/mobileTheme'
import { SOLUS_DARK_THEME_COLORS, SOLUS_LIGHT_THEME_COLORS } from '../../apps/mobile/src/theme/theme-colors'

// plan 017 §3 amendment: the app wears T3 Code's interface with Solus's theme.
// T3's components only name tokens (`bg-primary`, `bg-user-bubble`, …), so the
// theme is right exactly when those tokens carry Solus's colors, and the CSS
// the bundle reads is the one the palette produces.

describe('native mobile theme', () => {
  test('T3 tokens carry the Solus accent, canvas, and user bubble in both appearances', () => {
    for (const [appearance, colors] of [['light', SOLUS_LIGHT_THEME_COLORS], ['dark', SOLUS_DARK_THEME_COLORS]] as const) {
      const variables = getMobileThemeVariables(appearance)
      expect(variables['--color-primary']).toBe(colors.messageAction)
      expect(variables['--color-screen']).toBe(colors.canvas)
      expect(variables['--color-user-bubble']).toBe(colors.messageSurface)
      expect(variables['--color-foreground']).toBe(colors.text)
    }
    // Light filled actions are the deeper mobile accent (theme-colors.ts); the brand accent stays the focus.
    expect(getMobileThemeVariables('light')['--color-primary']).toBe('#b85c39')
    expect(getMobileThemeVariables('light')['--color-focus']).toBe('#d97757')
    expect(getMobileThemeVariables('dark')['--color-primary']).toBe('#e68e6b')
  })

  test('the checked-in theme CSS matches the palette (run scripts/generate-uniwind-theme.ts after a change)', () => {
    const css = readFileSync(join(import.meta.dir, '../../apps/mobile/generated-uniwind-theme.css'), 'utf8')
    for (const appearance of ['light', 'dark'] as const) {
      const block = css.slice(css.indexOf(`@variant ${appearance} {`))
      const body = block.slice(0, block.indexOf('}'))
      for (const [name, value] of Object.entries(getMobileThemeVariables(appearance))) {
        expect(body).toContain(`${name}: ${value};`)
      }
    }
  })
})
