import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMobileThemeVariables, type MobileThemeVariable } from '../../apps/mobile/src/lib/mobileTheme'
import { SOLUS_DARK_THEME_COLORS, SOLUS_LIGHT_THEME_COLORS } from '../../apps/mobile/src/theme/theme-colors'

// The phone wears Solus's own theme, read from the workspace CSS, not T3
// Code's defaults. The screen and thread list share the workspace canvas;
// a few text roles are deliberate mobile variants
// for reading on a phone (`theme-colors.ts`), held here to their contrast.

const workspaceCss = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/workspace.css'), 'utf8')
const mobileCss = readFileSync(join(import.meta.dir, '../../apps/mobile/global.css'), 'utf8')

/** The value of a token in the first `:root` block (light) or the first `.dark` block. */
function token(name: string, appearance: 'light' | 'dark'): string {
  const start = workspaceCss.indexOf(appearance === 'light' ? ':root {' : '.dark {')
  const block = workspaceCss.slice(start, workspaceCss.indexOf('\n}', start))
  const match = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m").exec(block)
  if (!match) throw new Error(`${name} is not in the ${appearance} block`)
  return match[1]!.trim().toLowerCase()
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number]
}

function contrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = channels(hex).map((value) => {
      const unit = value / 255
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
  }
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

describe('native mobile Solus theme', () => {
  test('the identity is the workspace\'s: ink, accent, container, and every dark surface', () => {
    expect(SOLUS_LIGHT_THEME_COLORS.text).toBe(token('solus-text-primary', 'light'))
    expect(SOLUS_LIGHT_THEME_COLORS.accent).toBe(token('solus-accent', 'light'))
    expect(SOLUS_LIGHT_THEME_COLORS.focus).toBe(token('solus-accent', 'light'))
    expect(SOLUS_LIGHT_THEME_COLORS.surface).toBe(token('solus-container-bg', 'light'))
    expect(SOLUS_LIGHT_THEME_COLORS.input).toBe(token('solus-container-border', 'light'))
    expect(SOLUS_DARK_THEME_COLORS.canvas).toBe(token('solus-sidebar-bg', 'dark'))
    expect(SOLUS_DARK_THEME_COLORS.text).toBe(token('solus-text-primary', 'dark'))
    expect(SOLUS_DARK_THEME_COLORS.accent).toBe(token('solus-accent', 'dark'))
  })

  test('status hues are desktop\'s, so a state wears the same colour on every client', () => {
    // WHY: T3's Tailwind pairs (emerald-600, amber-700, …) painted mobile
    // states darker and in other hues than desktop's --success, --warning,
    // --running, --review, and --failure.
    const desktop = { green: 'solus-art-3', amber: 'solus-art-2', blue: 'solus-art-5', purple: 'solus-art-6', red: 'solus-stop-bg' } as const
    // T3's class names stay; the pairs the app paints status with carry these hues.
    const adaptive = {
      green: '--color-adaptive-emerald-600-400',
      amber: '--color-adaptive-amber-700-400',
      blue: '--color-adaptive-sky-600-400',
      purple: '--color-adaptive-violet-600-400',
      red: '--color-adaptive-rose-600-400',
    } as const
    for (const [appearance, colors] of [['light', SOLUS_LIGHT_THEME_COLORS], ['dark', SOLUS_DARK_THEME_COLORS]] as const) {
      const variables = getMobileThemeVariables(appearance)
      for (const [hue, name] of Object.entries(desktop) as Array<[keyof typeof desktop, string]>) {
        expect({ appearance, hue, color: colors[hue] }).toEqual({ appearance, hue, color: token(name, appearance) })
        expect(variables[adaptive[hue]]).toBe(colors[hue])
      }
    }
  })

  test('the phone paints the app\'s own background, drawer, and bubble in both appearances', () => {
    // WHY: the web shell paints the opaque container colour edge to edge (its
    // boot style), so a native screen in any other colour reads as another app.
    const bootStyle = readFileSync(join(import.meta.dir, '../../apps/client/index.html'), 'utf8')
    const boot = {
      dark: /html:root, html:root body, html:root #root \{ background: (#[\da-f]{6})/i.exec(bootStyle)![1]!.toLowerCase(),
      light: /html:root\.light, html:root\.light body, html:root\.light #root \{ background: (#[\da-f]{6})/i.exec(bootStyle)![1]!.toLowerCase(),
    }
    for (const appearance of ['light', 'dark'] as const) {
      const variables = getMobileThemeVariables(appearance)
      const appBackground = token('solus-container-bg', appearance).slice(0, 7)
      expect(appBackground).toBe(boot[appearance])
      for (const role of ['--color-screen', '--color-thread-canvas', '--color-status-bar', '--color-sheet-solid'] as const) {
        expect({ appearance, role, color: variables[role] }).toEqual({ appearance, role, color: appBackground })
      }
      // Moving between the thread list and conversation must keep the same background.
      expect(variables['--color-drawer']).toBe(variables['--color-thread-canvas'])
    }
  })

  test('the sent user bubble is what desktop paints, read from its component, not a token name', () => {
    // WHY: `UserMessageBubble.svelte` mixes the ink into transparent over the
    // page; `--solus-user-bubble` is declared but unused, and reads as yellow.
    const bubble = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/conversation/UserMessageBubble.svelte'), 'utf8')
    const percent = Number(/: 'rounded-2xl bg-\[color-mix\(in_oklch,var\(--foreground\)_(\d+)%,transparent\)\]/.exec(bubble)![1])
    for (const appearance of ['light', 'dark'] as const) {
      const variables = getMobileThemeVariables(appearance)
      const ink = channels(variables['--color-foreground'])
      const page = channels(variables['--color-screen'])
      const painted = channels(variables['--color-user-bubble'])
      for (const [index, value] of painted.entries()) {
        expect(Math.abs(value - (ink[index]! * percent / 100 + page[index]! * (1 - percent / 100)))).toBeLessThan(1)
      }
      expect(variables['--color-user-bubble-foreground']).toBe(variables['--color-foreground'])
    }
  })

  test('grouped cards stand apart from the background: a light fill and a hairline in light, the raised card in dark', () => {
    const light = getMobileThemeVariables('light')
    // Light cards are a near-white fill, lighter than desktop's flattened `--muted` (#f2f2ef),
    // which reads as grey on a phone. The hairline border, not the fill, separates them.
    expect(light['--color-grouped-card']).not.toBe(light['--color-screen'])
    expect(contrast(light['--color-grouped-card'], light['--color-screen'])).toBeLessThan(contrast('#f2f2ef', light['--color-screen']))
    expect(light['--color-pr-card-border']).toBe('rgba(0, 0, 0, 0.06)')
    const dark = getMobileThemeVariables('dark')
    // Dark cards are the workspace's raised `--card` (its second `.dark` block).
    expect(dark['--color-grouped-card']).toBe(/\.dark \{\s*--card: (#[\da-f]{6});/i.exec(workspaceCss)![1])
  })

  test('text and status roles read at 4.5:1 on a phone in both appearances', () => {
    const pairs: Array<[MobileThemeVariable, MobileThemeVariable]> = [
      ['--color-foreground', '--color-screen'],
      ['--color-foreground-muted', '--color-grouped-card'],
      ['--color-foreground-secondary', '--color-card'],
      ['--color-placeholder', '--color-input'],
      ['--color-update-foreground', '--color-update'],
      ['--color-md-link', '--color-screen'],
    ]
    for (const appearance of ['light', 'dark'] as const) {
      const variables = getMobileThemeVariables(appearance)
      for (const [text, surface] of pairs) {
        expect({ appearance, text, ratio: contrast(variables[text], variables[surface]) >= 4.5 }).toEqual({ appearance, text, ratio: true })
      }
    }
    expect(contrast(SOLUS_DARK_THEME_COLORS.textMuted, SOLUS_DARK_THEME_COLORS.surface)).toBeGreaterThanOrEqual(4.5)
    // Error and warning text are desktop's red (--failure) and amber (--warning),
    // as desktop paints them, not darker shades tuned for the tinted cards.
    for (const appearance of ['light', 'dark'] as const) {
      expect(getMobileThemeVariables(appearance)['--color-danger-foreground']).toBe(token('solus-stop-bg', appearance))
      expect(getMobileThemeVariables(appearance)['--color-warning-foreground']).toBe(token('solus-art-2', appearance))
    }
  })

  test('a filled primary action is desktop\'s send button, in both appearances', () => {
    // WHY: the send button is the brand's one filled mark; a deeper mobile
    // shade made the phone's orange read as a different colour from desktop's.
    for (const [appearance, colors] of [['light', SOLUS_LIGHT_THEME_COLORS], ['dark', SOLUS_DARK_THEME_COLORS]] as const) {
      expect(colors.messageAction).toBe(token('solus-send-bg', appearance))
      expect(colors.messageActionHover).toBe(token('solus-send-hover', appearance))
      expect(colors.messageActionForeground).toBe(token('solus-text-on-accent', appearance))
      expect(getMobileThemeVariables(appearance)['--color-primary']).toBe(colors.messageAction)
    }
  })

  test('a prominent action (merge) is the ink fill with a canvas label, as T3\'s default theme', () => {
    // WHY: T3 #18506 gives the strongest PR action its own token. On the
    // default theme it is the foreground ink, and its label must read as text.
    for (const appearance of ['light', 'dark'] as const) {
      const variables = getMobileThemeVariables(appearance)
      expect(variables['--color-prominent-action']).toBe(variables['--color-foreground'])
      expect(variables['--color-prominent-action-foreground']).toBe(variables['--color-screen'])
      expect(contrast(variables['--color-prominent-action-foreground'], variables['--color-prominent-action'])).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('the composer is the Solus input pill with the container ring', () => {
    // WHY: T3's composer is tonal glass; Solus's is its own input surface with
    // the container's ring, a soft drop in light and none in dark.
    const light = getMobileThemeVariables('light')
    const dark = getMobileThemeVariables('dark')
    expect(light['--color-composer-surface']).toBe('#ffffff')
    expect(dark['--color-composer-surface']).toBe('#222120')
    expect(light['--color-composer-border']).toBe(token('solus-container-border', 'light'))
    expect(dark['--color-composer-shadow']).toBe('rgba(0, 0, 0, 0)')
    expect(light['--color-composer-shadow']).not.toBe(dark['--color-composer-shadow'])
  })

  test('text is set in the system font, as Solus sets it', () => {
    expect(mobileCss).not.toContain('DMSans')
    expect(mobileCss).toContain('--font-sans: "System";')
    expect(mobileCss).toContain('--font-sans: "sans-serif";')
  })
})
