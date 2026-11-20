import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * The maintainer: "remove the orange border when selected from the root
 * component not the actual border". A dialog whose container takes the focus
 * drew the browser's own focus outline around the whole dialog, in the system
 * accent colour. One rule at the root removes it for every dialog of the app.
 */
const css = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/workspace.css'), 'utf8')
const layers = [...css.matchAll(/@layer base \{([\s\S]*?)\n\}/g)].map((match) => match[1])
const rule = layers.map((layer) => layer.match(/(:where\([^)]*dialog[^)]*\)[^{]*)\{([^}]*)\}/)).find(Boolean)

describe('the focus ring of a dialog container', () => {
  test('every kind of dialog container is covered, at the root', () => {
    // WHY: a fix dialog by dialog misses the next dialog; native, bits-ui, and hand-made dialogs all match.
    expect(rule?.[1]).toContain('dialog')
    expect(rule?.[1]).toContain('[role="dialog"]')
    expect(rule?.[1]).toContain('[role="alertdialog"]')
    expect(rule?.[1]).toContain(':focus-visible')
  })

  test('only the outline goes: the border and the shadow of a dialog stay', () => {
    // WHY: dialogs that have an outline border keep it; the ring was the outline, not the border.
    const declarations = rule?.[2].split(';').map((part) => part.trim()).filter(Boolean)
    expect(declarations).toEqual(['outline: none'])
  })

  test('the rule is in the base layer, so a utility on a dialog still wins', () => {
    // WHY: unlayered CSS beats every utility (packages/workspace-ui/CLAUDE.md).
    expect(rule).toBeDefined()
  })
})
