import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * One black, not two.
 *
 * On a phone Safari paints the safe areas above and below the app with the
 * page's own background, so that background has to be the colour the web shell
 * fills the viewport with — the opaque form of `--solus-container-bg`. It is
 * also the colour the `theme-color` meta is derived from, so a drift here moves
 * the browser chrome as well.
 *
 * Two rules are asserted, because both failed silently and only showed up on a
 * device, as a stripe. The boot style in the client's document is what paints
 * before any script runs and what `applyTheme` has to agree with. And no
 * stylesheet rule may claim <html> for the web shell: `html, body, #root` is
 * already `background: transparent !important` for Electron's transparent
 * window, so any second `!important` rule on <html> outranks the boot style and
 * the inline background alike — which is exactly how `--solus-edge-bg` came to
 * paint the page while the toolbars stayed on the container colour.
 */

function read(path: string): string {
  return readFileSync(join(import.meta.dir, '../..', path), 'utf8')
}

const clientDocument = read('apps/client/index.html')
const settings = read('packages/workspace-ui/src/contexts/app/settings.context.svelte.ts')
const stylesheet = read('packages/workspace-ui/src/index.css')

/** The literals `applyTheme` settles the web shell's page background on. */
function runtimeEdgeColor(mode: 'dark' | 'light'): string {
  const branch = settings.match(/const edgeColor = isDark \? '(#[0-9a-f]{6})' : '(#[0-9a-f]{6})'/i)
  expect(branch).not.toBeNull()
  return (mode === 'dark' ? branch![1] : branch![2]).toLowerCase()
}

describe('web shell edge colour', () => {
  test('the boot background is the colour applyTheme settles on', () => {
    const dark = clientDocument.match(/html:root,[^}]*background:\s*(#[0-9a-f]{6})/i)
    const light = clientDocument.match(/html:root\.light,[^}]*background:\s*(#[0-9a-f]{6})/i)
    expect(dark?.[1].toLowerCase()).toBe(runtimeEdgeColor('dark'))
    expect(light?.[1].toLowerCase()).toBe(runtimeEdgeColor('light'))
  })

  test('no stylesheet rule claims the web shell page background', () => {
    const rules = stylesheet
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/html\.solus-web[^{]*\{[^}]*\}/g)
    for (const rule of rules ?? []) {
      expect(rule).not.toMatch(/background/)
    }
  })
})
