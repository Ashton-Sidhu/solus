import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_COLOR_TOKENS, THEME_CSS_HOOKS, themeCssLoadsFiles, themeCssValueLoadsFile } from '@solus/contracts/theme-css'
import { PERSONAL_SETTING_SCHEMAS } from '@solus/contracts/settings'
import { stripFileLoads, type ThemeRuleParent } from '../../packages/workspace-ui/src/contexts/app/theme-css'

const workspaceUi = join(import.meta.dir, '../../packages/workspace-ui/src')

/** A parsed declaration block, as the CSSOM gives it to the guard. */
function declarations(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries))
  return {
    get length() { return values.size },
    item: (index: number) => [...values.keys()][index] ?? '',
    getPropertyValue: (property: string) => values.get(property) ?? '',
    removeProperty: (property: string) => { values.delete(property); return '' },
    has: (property: string) => values.has(property),
  }
}

/** A sheet or grouping rule whose rules the guard can delete. */
function parent<T extends { cssText: string }>(rules: T[]) {
  return { cssRules: rules, deleteRule: (index: number) => { rules.splice(index, 1) } }
}

// WHY: theme CSS comes from agents and from pastes. A declaration that loads a
// file can send what is on screen to another host, so the client drops it.
describe('theme CSS cannot load files', () => {
  test('a remote url(), image-set(), and src() load a file; data: and #id do not', () => {
    expect(themeCssValueLoadsFile('url(https://example.com/a.png)')).toBe(true)
    expect(themeCssValueLoadsFile('url("//example.com/a.png")')).toBe(true)
    expect(themeCssValueLoadsFile('image-set("a.png" 1x)')).toBe(true)
    expect(themeCssValueLoadsFile('src("a.woff2")')).toBe(true)
    expect(themeCssValueLoadsFile('url(data:image/png;base64,AAAA)')).toBe(false)
    expect(themeCssValueLoadsFile('url( "data:image/svg+xml,<svg/>")')).toBe(false)
    expect(themeCssValueLoadsFile('url(#grain)')).toBe(false)
    expect(themeCssValueLoadsFile('#7aa2f7')).toBe(false)
  })

  test('an escape or a non-breaking space cannot disguise a load', () => {
    // A backslash can spell `url` or `var` inside a custom property that is parsed only at use.
    expect(themeCssValueLoadsFile('u\\72l(https://example.com)')).toBe(true)
    // U+00A0 is not CSS whitespace, so the address after it is relative, not data:.
    expect(themeCssValueLoadsFile('url( data:x)')).toBe(true)
  })

  test('the text check refuses @import, but ignores a load inside a comment', () => {
    expect(themeCssLoadsFiles('@import "theme.css";')).toBe(true)
    expect(themeCssLoadsFiles('/* url(https://example.com) */ :root { --solus-accent: red }')).toBe(false)
  })

  test('the guard drops each declaration that loads a file and keeps the safe ones', () => {
    const style = declarations({ color: 'red', background: 'url(https://example.com/a)', '--wave': 'url(data:image/png;base64,AA)' })
    stripFileLoads(parent([{ cssText: 'body {}', style }]))
    expect(style.has('color')).toBe(true)
    expect(style.has('--wave')).toBe(true)
    expect(style.has('background')).toBe(false)
  })

  test('the guard reaches nested rules, keyframes, and registered properties', () => {
    const nested = declarations({ background: 'url(https://example.com/m)' })
    const frame = declarations({ background: 'url(https://example.com/k)' })
    const media = parent([{ cssText: 'body {}', style: nested }])
    const sheet = parent<{ cssText: string; initialValue?: string; cssRules?: unknown[]; appendRule?: unknown }>([
      { cssText: '@media', ...media },
      { cssText: '@keyframes', cssRules: [{ cssText: '0%', style: frame }], appendRule: () => {} },
      { cssText: '@property --a', initialValue: 'url(https://example.com/p)' },
      { cssText: '@property --b', initialValue: '#fff' },
    ])
    stripFileLoads(sheet as ThemeRuleParent)
    expect(nested.has('background')).toBe(false)
    expect(frame.has('background')).toBe(false)
    expect(sheet.cssRules.map((rule) => rule.cssText)).toEqual(['@media', '@keyframes', '@property --b'])
  })

  test('the guard drops an at-rule it cannot check, and keeps a layer order and a namespace', () => {
    const sheet = parent<{ cssText: string; nameList?: string[]; namespaceURI?: string }>([
      { cssText: '@counter-style' },
      { cssText: '@layer a, b;', nameList: ['a', 'b'] },
      { cssText: '@namespace svg', namespaceURI: 'http://www.w3.org/2000/svg' },
    ])
    stripFileLoads(sheet)
    expect(sheet.cssRules.map((rule) => rule.cssText)).toEqual(['@layer a, b;', '@namespace svg'])
  })

  test('the personal setting refuses CSS that loads a file, and CSS over the limit', () => {
    expect(PERSONAL_SETTING_SCHEMAS.themeCss.safeParse(':root { --solus-accent: #7aa2f7 }').success).toBe(true)
    expect(PERSONAL_SETTING_SCHEMAS.themeCss.safeParse('').success).toBe(true)
    expect(PERSONAL_SETTING_SCHEMAS.themeCss.safeParse('a { background: url(https://example.com) }').success).toBe(false)
    expect(PERSONAL_SETTING_SCHEMAS.themeCss.safeParse('a{}'.repeat(10_000)).success).toBe(false)
  })
})

// WHY: theme CSS that a person or an agent wrote keeps working only while the
// selectors and tokens the guide promises stay in the app. Rename one here too.
describe('the theme guide matches the app', () => {
  const source = readdirSync(workspaceUi, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(svelte|ts)$/.test(file) && !file.includes('.test.'))
    .map((file) => readFileSync(join(workspaceUi, file), 'utf8'))
    .join('\n')
  const stylesheet = readFileSync(join(workspaceUi, 'workspace.css'), 'utf8')

  test.each(THEME_CSS_HOOKS.map((hook) => hook.slot))('[data-slot="%s"] is still in the workspace UI', (slot) => {
    // The slot is written in markup, or passed to a panel that renders it as one.
    expect(new RegExp(`(data-slot|region)=\\{?["']${slot}["']`).test(source)).toBe(true)
  })

  test.each(THEME_COLOR_TOKENS.map((entry) => entry.token))('%s is set for light and dark', (token) => {
    const definitions = stylesheet.match(new RegExp(`^\\s*${token}:`, 'gm')) ?? []
    expect(definitions.length).toBeGreaterThanOrEqual(2)
  })
})
