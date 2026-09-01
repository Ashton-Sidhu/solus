import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { collect, countByKey, findSpills, readBaseline, regressions } from '../../scripts/check-layout-discipline'

// A pane is legally ~356px wide (25% of a 1440px split), so a surface that asks
// the window how wide it is renders wrong by that much, and a leaf that shrinks
// past its rigid children paints over its neighbour. `lint:layout` enforces
// that; these tests make the same rule fail `test:unit`, and pin the two ways
// the checker itself could stop meaning anything.

const root = new URL('../../', import.meta.url).pathname

describe('pane width honesty', () => {
  test('no surface reads the window where a container is the honest answer', () => {
    // WHY: the baseline is the WP4 queue. Growing it re-introduces the bug class
    // the plan exists to end; shrinking it without recording the win means the
    // next contributor inherits a stale queue.
    const counts = countByKey(collect(root))
    expect(regressions(counts, readBaseline(root))).toEqual([])
  })

  test('the baseline never silently outlives its defects', () => {
    // WHY: a baseline that only ever grows is a suppression file. Every entry
    // must still correspond to a real finding, or the count is fiction.
    const counts = countByKey(collect(root))
    const stale = Object.keys(readBaseline(root)).filter((key) => !(key in counts))
    expect(stale).toEqual([])
  })

  test('naming a window read in a comment is not a window read', () => {
    // WHY: the fix for one of these is usually a comment explaining which axis
    // replaced it. A checker that flagged that comment would make the rule
    // undiscussable, and the next person would delete the explanation rather
    // than the defect. `InputBar.svelte` is the live case: it names
    // `isMobileViewport` in prose and reads it nowhere.
    const bar = 'packages/workspace-ui/src/components/input/InputBar.svelte'
    expect(readFileSync(`${root}${bar}`, 'utf8')).toContain('isMobileViewport')
    expect(collect(root).filter((finding) => finding.path === bar)).toEqual([])
  })

  test('the spill rule needs the whole triple, not min-w-0 alone', () => {
    // WHY: 566 files carry `min-w-0` and only a handful were ever defects. A
    // checker that flagged the class would be switched off within a week, so the
    // discrimination between a flex container delegating truncation and a leaf
    // lying about its box IS the rule, not an optimisation of it.
    const leaf = (cls: string, child: string) =>
      `<button class="${cls}"><span class="${child}">x</span></button>`

    // The defect: shrinks past its content, rigid child, nothing to clip it.
    expect(findSpills(leaf('flex min-w-0', 'shrink-0'), 'f.svelte')).toHaveLength(1)
    // Clipped — the child cannot paint over the neighbour.
    expect(findSpills(leaf('flex min-w-0 overflow-hidden', 'shrink-0'), 'f.svelte')).toEqual([])
    // Nothing rigid inside, so there is nothing to escape the box.
    expect(findSpills(leaf('flex min-w-0', 'truncate'), 'f.svelte')).toEqual([])
    // A container, not a leaf: `min-w-0` here is correct and necessary.
    expect(findSpills('<div class="flex min-w-0"><span class="shrink-0">x</span></div>', 'f.svelte')).toEqual([])
  })

  test('no interactive leaf in components/ spills today', () => {
    // WHY: this is the outcome the rule exists for, and it belongs in the suite
    // rather than only in a baseline file someone can regenerate.
    expect(collect(root).filter((finding) => finding.rule === 'spill')).toEqual([])
  })
})
