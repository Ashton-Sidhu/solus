import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOLUS_THEME_SNAPSHOT,
  SOLUS_THEME_VARIABLES,
  sandboxThemeCss,
} from '../../packages/contracts/src/artifact-sandbox'

const workspaceCss = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/workspace.css'), 'utf8')

/** The declarations of the first block that opens with `selector`. */
function declarations(selector: string): Map<string, string> {
  const start = workspaceCss.indexOf(`\n${selector} {`)
  const body = workspaceCss.slice(start, workspaceCss.indexOf('\n}', start))
  const found = new Map<string, string>()
  for (const match of body.matchAll(/^\s*(--[a-z0-9-]+):\s*(.+?);/gm)) {
    if (!found.has(match[1])) found.set(match[1], match[2].trim())
  }
  return found
}

describe('the server preview wears the theme the reader sees', () => {
  test('every snapshot value is what workspace.css declares', () => {
    // WHY: the headless preview has no document to read the theme from. If the
    // snapshot drifts, the agent checks a page in colours the reader never sees.
    const light = declarations(':root')
    const dark = declarations('.dark')
    for (const variable of SOLUS_THEME_VARIABLES) {
      expect({ variable, value: SOLUS_THEME_SNAPSHOT.light[variable] }).toEqual({ variable, value: light.get(variable)! })
      // A variable the dark block does not restate keeps its light value.
      expect({ variable, value: SOLUS_THEME_SNAPSHOT.dark[variable] }).toEqual({ variable, value: dark.get(variable) ?? light.get(variable)! })
    }
  })

  test('the snapshot fills every token a render is taught', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const css = sandboxThemeCss(appearance === 'dark', (variable) => SOLUS_THEME_SNAPSHOT[appearance][variable])
      for (const token of ['--background', '--foreground', '--card', '--border', '--primary', '--chart-1', '--chart-6', '--font-sans']) {
        expect(css).toMatch(new RegExp(`${token}:[^;]+;`))
      }
    }
  })

  test('a render takes its accent from the render palette, the brand terracotta', () => {
    // WHY: a render's accent is the brand terracotta in both modes, so an
    // artifact reads as Solus.
    for (const appearance of ['light', 'dark'] as const) {
      const values = SOLUS_THEME_SNAPSHOT[appearance]
      const css = sandboxThemeCss(appearance === 'dark', (variable) => values[variable])
      expect(css).toContain(`--primary:${values['--solus-render-accent']};`)
      expect(css).toContain(`--ring:${values['--solus-render-accent']};`)
    }
    for (const appearance of ['light', 'dark'] as const) {
      const values = SOLUS_THEME_SNAPSHOT[appearance]
      expect(values['--solus-render-accent']).toBe(values['--solus-accent'])
    }
  })

  test('a selected fill is a tint of the first series, never of the error hue', () => {
    // WHY: a terracotta tint and the error tint were both pale pink, so a
    // selected row read as a mild error. Selection takes the day blue of
    // --chart-1, far from --destructive.
    for (const appearance of ['light', 'dark'] as const) {
      const values = SOLUS_THEME_SNAPSHOT[appearance]
      const css = sandboxThemeCss(appearance === 'dark', (variable) => values[variable])
      const selection = oklchHue(firstHex(tokenValue(css, '--accent-surface')))
      expect({ appearance, nearFirstSeries: hueDistance(selection, oklchHue(values['--solus-render-1'])) < 10 }).toEqual({ appearance, nearFirstSeries: true })
      expect({ appearance, farFromError: hueDistance(selection, oklchHue(tokenValue(css, '--destructive'))) > 90 }).toEqual({ appearance, farFromError: true })
    }
  })

  test('a warning is amber, not green-yellow, and its text passes AA', () => {
    // WHY: a yellow near 85° reads as green-yellow as a tint and as brown as
    // text. An amber nearer orange stays warm at every lightness.
    for (const appearance of ['light', 'dark'] as const) {
      const values = SOLUS_THEME_SNAPSHOT[appearance]
      const css = sandboxThemeCss(appearance === 'dark', (variable) => values[variable])
      const warning = oklchHue(tokenValue(css, '--warning'))
      expect({ appearance, amber: warning >= 45 && warning <= 85 }).toEqual({ appearance, amber: true })
      const page = hexColor(values['--solus-container-bg'])
      const foreground = tokenValue(css, '--warning-foreground')
      expect({ appearance, aa: contrast(hexColor(foreground), page) >= 4.5 }).toEqual({ appearance, aa: true })
      // A warm colour with little chroma is brown, not orange.
      expect({ appearance, notBrown: oklchChroma(foreground) >= 0.13 }).toEqual({ appearance, notBrown: true })
    }
  })

  test('a table takes the page text colour and font', () => {
    // WHY: a render runs in quirks mode, where a table does not inherit the
    // page's font or text colour. It took a 16px font and the system text
    // colour, so it was larger than the page text and unreadable on a panel
    // the render paints in the other mode.
    const css = sandboxThemeCss(true, (variable) => SOLUS_THEME_SNAPSHOT.dark[variable])
    expect(css).toMatch(/:where\(table\)\{color:inherit;font:inherit\}/)
  })

  test('the chart series keep one hue order in both modes, with the brand terracotta last', () => {
    // WHY: an agent takes --chart-1 first for a category or a diagram zone. A
    // tint of the terracotta reads as salmon, near the warning and error
    // colours, so the brand accent is the last series. Each series keeps its
    // hue across modes, so a legend keeps its meaning when the mode changes.
    for (const appearance of ['light', 'dark'] as const) {
      const values = SOLUS_THEME_SNAPSHOT[appearance]
      const css = sandboxThemeCss(appearance === 'dark', (variable) => values[variable])
      expect(css).toContain(`--chart-6:${values['--solus-render-accent']};`)
      expect(css).not.toContain(`--chart-1:${values['--solus-render-accent']};`)
    }
    for (const series of [1, 2, 3, 4, 5, 6] as const) {
      const variable = `--solus-render-${series}` as const
      const light = oklchHue(SOLUS_THEME_SNAPSHOT.light[variable])
      const dark = oklchHue(SOLUS_THEME_SNAPSHOT.dark[variable])
      expect({ series, sameHue: hueDistance(light, dark) < 25 }).toEqual({ series, sameHue: true })
    }
  })

  test('muted text is readable and clearly lighter than body text', () => {
    // WHY: a description in the same weight of colour as its title gives a
    // render no hierarchy. Muted text must still pass WCAG AA on the page.
    for (const appearance of ['light', 'dark'] as const) {
      const values = SOLUS_THEME_SNAPSHOT[appearance]
      const css = sandboxThemeCss(appearance === 'dark', (variable) => values[variable])
      const muted = /--muted-foreground:([^;]+);/.exec(css)![1]
      const page = hexColor(values['--solus-container-bg'])
      const text = hexColor(values['--solus-text-primary'])
      const bodyContrast = contrast(text, page)
      const mutedContrast = contrast(resolveTextWash(muted, text, page), page)
      expect({ appearance, aa: mutedContrast >= 4.5 }).toEqual({ appearance, aa: true })
      expect({ appearance, lighter: mutedContrast <= bodyContrast * 0.6 }).toEqual({ appearance, lighter: true })
    }
  })

  test('a mock-up of Solus can still wear the app accent', () => {
    // WHY: a render's --primary is the calm render accent, so a mock-up of a
    // Solus card drew blue buttons the real app never shows. --brand is the
    // app's own accent and its button text, in both modes.
    for (const appearance of ['light', 'dark'] as const) {
      const values = SOLUS_THEME_SNAPSHOT[appearance]
      const css = sandboxThemeCss(appearance === 'dark', (variable) => values[variable])
      expect(css).toContain(`--brand:${values['--solus-accent']};`)
      expect(css).toContain(`--brand-foreground:${values['--solus-text-on-accent']};`)
    }
  })
})

type Rgb = readonly [number, number, number]

/** `#rrggbb` or `#rrggbbaa`, as 0–255 channels; the alpha is ignored. */
function hexColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim())![1]
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb
}

/** A colour as the page shows it: a hex value, or a wash of the text colour
 *  (`color-mix(... var(--solus-text-primary) N%, transparent)`) over the page. */
function resolveTextWash(value: string, text: Rgb, page: Rgb): Rgb {
  const wash = /var\(--solus-text-primary\)\s+([\d.]+)%,\s*transparent/.exec(value)
  if (!wash) return hexColor(value)
  const alpha = Number(wash[1]) / 100
  return text.map((channel, index) => channel * alpha + page[index] * (1 - alpha)) as unknown as Rgb
}

function linear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function contrast(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/** The OKLCH hue of a hex colour, in degrees. */
function oklchHue(value: string): number {
  const [r, g, b] = hexColor(value).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return (Math.atan2(bAxis, a) * 180 / Math.PI + 360) % 360
}

function hueDistance(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360
  return gap > 180 ? 360 - gap : gap
}

/** The value a theme stylesheet gives one token. */
function tokenValue(css: string, token: string): string {
  return new RegExp(`${token}:([^;]+);`).exec(css)![1]
}

/** The first hex colour in a value, such as the tint colour of a `color-mix`. */
function firstHex(value: string): string {
  return /#[0-9a-f]{6}/i.exec(value)![0]
}

/** The OKLCH chroma of a hex colour. */
function oklchChroma(value: string): number {
  const [r, g, b] = hexColor(value).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)
}
