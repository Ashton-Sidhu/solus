import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/prs/PrsPage.svelte'),
  'utf8',
)

describe('PR detail panel animation', () => {
  test('keeps the panel out of the list flow so neither direction animates layout', () => {
    // WHY: in flow, the panel's arrival and departure were layout events — the
    // list had to travel with it, animating a width that never reaches the
    // compositor, in the same frames PrDetailPanel mounts in. Positioned over
    // the room the list leaves, the fly is transform and opacity alone.
    expect(source).toMatch(
      /: 'absolute inset-y-0 right-0 left-\(--pr-list-width\) z-10 min-w-0 shadow-/,
    )
  })

  test('sizes the list and the panel from one measure', () => {
    // WHY: the panel's left edge IS the list's width. Two literals would drift
    // apart and leave a gap or an overlap the moment either is retuned.
    expect(source).toContain('[--pr-list-width:380px]')
    expect(source).toMatch(/\? 'w-\(--pr-list-width\)'/)
  })

  test('resizes the list in one layout pass, both ways', () => {
    // WHY: with the panel out of flow there is nothing left for a width
    // transition to stay in sync with, so the list simply takes its new size.
    expect(source).not.toMatch(/transition-\[width\]/)
  })

  test('removes the panel transition when reduced motion is requested', () => {
    expect(source).toContain('duration: reduceMotion ? 0 : 200')
  })
})
