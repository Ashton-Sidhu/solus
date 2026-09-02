import { describe, expect, test } from 'bun:test'
import { findLaptopOverTouch } from '../../scripts/check-layout-discipline'

// `.is-laptop-display` is toggled from `screen.width <= 1600`, so it is on for
// every phone and tablet, not just a small MacBook. That makes a bare
// `[.is-laptop-display_&]:h-6` — a descendant combinator, two selectors —
// outrank the `pointer-coarse:h-10` beside it, which is one class inside a
// media query that adds no specificity of its own. The hand asked for a 40px
// target and got 24px, and no order of writing could change it.
//
// These tests pin when the rule fires, because the interesting part is what it
// leaves alone: a laptop value with no touch counterpart is a product choice,
// and a fenced one is the fix.

const tag = (classes: string) => `<button class="${classes}"></button>`

describe('findLaptopOverTouch', () => {
  test('reports a laptop value that defeats the touch rung beside it', () => {
    const failures = findLaptopOverTouch(tag('h-7 [.is-laptop-display_&]:h-6.5 pointer-coarse:h-10'), 'a.svelte')
    expect(failures).toHaveLength(1)
    expect(failures[0].rule).toBe('laptop-outranks-touch')
  })

  test('a fenced laptop value is the fix, not a defect', () => {
    const fenced = tag('h-7 pointer-fine:[.is-laptop-display_&]:h-6.5 pointer-coarse:h-10')
    expect(findLaptopOverTouch(fenced, 'a.svelte')).toEqual([])
  })

  test('a laptop value with no touch counterpart is left alone', () => {
    // The author never wrote a touch rung for this property, so nothing is
    // being defeated. Flagging it would be inventing a product decision.
    expect(findLaptopOverTouch(tag('h-7 [.is-laptop-display_&]:h-6.5'), 'a.svelte')).toEqual([])
  })

  test('the two rungs have to be the same property', () => {
    expect(findLaptopOverTouch(tag('[.is-laptop-display_&]:h-6 pointer-coarse:px-5'), 'a.svelte')).toEqual([])
  })

  // `min-h` must not be read as `h` wearing a `min-` prefix: they are different
  // properties, and a floor beside a fixed height is exactly the shape the
  // publish-menu fix relies on.
  test('a longer property name is not matched as a shorter one', () => {
    expect(findLaptopOverTouch(tag('[.is-laptop-display_&]:min-h-6 pointer-coarse:h-10'), 'a.svelte')).toEqual([])
  })

  // A tag's attributes span lines, and a shared list in a `lib/*-styles.ts` is
  // a concatenation across several. A line-based check misses both — it did
  // miss `rail-styles.ts`, whose laptop height and touch height sit six lines
  // apart on the same control.
  test('finds the collision when the class list spans lines', () => {
    const multiline = `<button\n  class="h-7\n    [.is-laptop-display_&]:h-6\n    pointer-coarse:h-10"\n></button>`
    expect(findLaptopOverTouch(multiline, 'a.svelte')).toHaveLength(1)
  })

  test('finds it in a shared style constant too', () => {
    const styles = [
      "export const ROW = 'flex h-7'",
      "export const TRIGGER =",
      "  'flex h-7 items-center ' +",
      "  '[.is-laptop-display_&]:h-6 ' +",
      "  'pointer-coarse:h-10'",
    ].join('\n')
    const failures = findLaptopOverTouch(styles, 'lib/rail-styles.ts')
    expect(failures).toHaveLength(1)
    // Attributed to the declaration that owns it, not to the first one.
    expect(failures[0].line).toBe(2)
  })
})
