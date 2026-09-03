import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The symbol card floats over the diff and the file editor, which draw code at
// `--solus-code-font-size`. When the card's own type does not follow the
// display, it is the one surface in the workspace that stays at its desktop
// size while everything under and around it steps down on a laptop — a 14px
// card sitting on 12px code. Every size on this surface is therefore a named
// rung that carries its own laptop step, and these tests pin that rather than
// the pixels.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname
const CARD = [
  readFileSync(`${UI}components/code-intel/CodeIntelPopover.svelte`, 'utf8'),
  readFileSync(`${UI}components/code-intel/CodeIntelReferenceList.svelte`, 'utf8'),
].join('\n')
const CSS = readFileSync(`${UI}index.css`, 'utf8')
const TW = readFileSync(`${UI}lib/tw.ts`, 'utf8')

/** The card's own rungs, plus the two shared ones it hangs from. */
const CARD_RUNGS = ['workspace-chrome', 'symbol-card-meta', 'symbol-card-code', 'micro'] as const

/** The laptop step block: `@media (pointer: fine) { html.is-laptop-display { … } }`. */
const laptopBlock = () => {
  const start = CSS.indexOf('html.is-laptop-display {')
  expect(start).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start))
}

describe('symbol card typography', () => {
  test('every font size on the card is a rung that steps on a laptop', () => {
    // WHY: this is the whole point of the surface's ladder. `text-menu` and
    // `text-chrome-shelf` are deliberately flat at 14px and 12px on both
    // displays — correct for a menu, wrong for a card that has to sit level
    // with the code under it. A literal `text-[13px]` is worse: it follows
    // neither the display nor the coarse-pointer guard, and it does not move
    // when the ladder is retuned.
    const sizes = [...CARD.matchAll(/(?:^|[\s"'])(?:lg:)?text-([a-z][a-z0-9-]*|\[[^\]]+\])(?=[\s"'])/g)]
      .map((match) => match[1])
      // Colour utilities share the `text-` prefix; only sizes are in scope.
      .filter((suffix) => !suffix.startsWith('(') && !suffix.startsWith('[color:'))
      .filter((suffix) => !['left', 'right', 'center', 'pretty', 'balance'].includes(suffix))
    const offenders = sizes.filter((suffix) => !(CARD_RUNGS as readonly string[]).includes(suffix))
    expect(offenders).toEqual([])
  })

  test('the card-owned rungs declare a laptop step beside their base value', () => {
    // WHY: a rung declared once and never stepped is indistinguishable from a
    // literal size at every width but one. The failure is invisible on the
    // author's monitor and only appears on the display the step exists for.
    const laptop = laptopBlock()
    for (const rung of ['symbol-card-meta', 'symbol-card-code']) {
      expect(CSS).toContain(`--text-${rung}:`)
      expect(laptop).toContain(`--text-${rung}:`)
    }
  })

  test('the card-owned rungs are registered with tailwind-merge', () => {
    // WHY: tailwind-merge guesses the property group of any key outside the
    // stock scales, reads a `text-*` rung as a colour, and deletes it against
    // the `text-(--solus-…)` beside it. The class then never reaches the DOM,
    // with no warning, and the element silently inherits its parent's size.
    for (const rung of ['symbol-card-meta', 'symbol-card-code']) {
      expect(TW).toContain(`'text-${rung}'`)
    }
  })

  test('quoted code sits under the sans filename above it, on both displays', () => {
    // WHY: monospace at an equal size reads larger than the sans beside it, so
    // code set to the body rung takes the reference list over — that was the
    // defect this ladder was drawn to fix. The gap is what carries the
    // hierarchy, and it has to survive the laptop step rather than close on it.
    const laptop = laptopBlock()
    const size = (source: string, rung: string) =>
      Number(new RegExp(`--text-${rung}: ([0-9.]+)rem`).exec(source)?.[1])

    expect(size(CSS, 'symbol-card-code')).toBeLessThan(size(CSS, 'workspace-chrome'))
    expect(size(laptop, 'symbol-card-code')).toBeLessThan(size(laptop, 'workspace-chrome'))
    // The line number annotating that code stays a step under the code itself.
    expect(size(laptop, 'micro')).toBeLessThan(size(laptop, 'symbol-card-code'))
  })
})
