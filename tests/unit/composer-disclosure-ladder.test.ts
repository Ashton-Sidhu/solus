import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The composer row is a declared ladder, not a flexbox negotiation. These tests
// pin the two things that make it a ladder: every rung exists at the width it
// claims, and the floor is not droppable.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname

const read = (path: string) => readFileSync(`${UI}${path}`, 'utf8')

const toolbar = read('components/input/InputToolbar.svelte')
const chip = read('components/pickers/SessionChip.svelte')
const permission = read('components/pickers/PermissionModePicker.svelte')
const status = read('components/layout/StatusBarControls.svelte')
const bar = read('components/input/InputBar.svelte')

// Widest rung first. Every entry names the file that owns the control, so a
// control that moves has to move its rung with it.
type Rung = { width: string, drops: string, source: string }

const LADDER: Rung[] = [
  { width: '30rem', drops: 'saved-prompts control', source: toolbar },
  { width: '26rem', drops: 'reasoning label', source: chip },
  { width: '22rem', drops: 'status cluster', source: status },
  { width: '18rem', drops: 'permission label', source: permission },
  { width: '15rem', drops: 'model label', source: chip },
]

describe('composer disclosure ladder', () => {
  test.each(LADDER)('drops the $drops below $width', ({ width, source }) => {
    // WHY: a rung that exists only in the plan is not a ladder. Each one has to
    // be a real container query against `composer` — not a media query, which
    // would measure the window and fire at the wrong time inside a pane.
    expect(source).toContain(`@max-[${width}]/composer:hidden`)
  })

  test('mic and send are in no rung, at any width', () => {
    // WHY: this is the assertion that encodes why the ladder matters. The floor
    // is text well + mic + send; below it the composer is absent, not degraded.
    // It fails the moment someone makes send droppable to win back 64px.
    const actionRow = bar.slice(bar.indexOf('{@render leadingActions('))
    const rowEnd = actionRow.indexOf('{@render actionButtons()}')
    expect(rowEnd).toBeGreaterThan(-1)
    expect(actionRow.slice(0, rowEnd)).not.toMatch(/@max-\[[^\]]+\]\/composer:hidden/u)
  })

  test('the ladder measures the card, not a zoomed row', () => {
    // WHY: `zoom` put the toolbar row in a different coordinate space from the
    // `composer` container querying it, so at a 1.15 text preference a 26rem
    // card held ~22.6rem of row and every rung fired late. Re-adding it would
    // silently de-tune all five rungs rather than break anything visibly.
    const row = bar.slice(bar.indexOf('{#if leadingActions}'), bar.indexOf('{@render actionButtons()}'))
    expect(row).not.toContain('zoom:')
  })

  test('the composer root does not clip its own toolbar row', () => {
    // WHY: the root has no padding, so its right and bottom edges land exactly
    // on the toolbar row — the stop button's right edge and the model chip's
    // bottom edge sit on them. `contain: paint` therefore cut the stop button's
    // outset ring off on the right and shaved the chip's hairline. Layout
    // containment is the part worth keeping; the card one level out already
    // clips, 12px further away.
    expect(bar).toContain('contain:layout"')
    expect(bar).not.toContain('contain:layout paint')
  })

  test('every composer that renders the toolbar declares the container', () => {
    // WHY: a rung against a container nobody declared never fires, and it fails
    // silently — no build error, no warning, the control simply never hides.
    // `PromptComposer` is the fourth card: it mounts the same `SessionChip`, so
    // the chip's two rungs were dead in the diff, review-guide and plan bars
    // until the card declared the container they name.
    for (const path of [
      'components/input/EditorInputCard.svelte',
      'components/layout/PillLayout.svelte',
      'components/session-draft/SessionDraftPane.svelte',
      'components/ui/prompt-composer/prompt-composer.svelte',
    ]) {
      expect(read(path)).toContain('@container/composer')
    }
  })

  test('the shared prompt composer measures the card, not a zoomed row', () => {
    // WHY: the same defect as the test above, at the second of the two sites
    // that carried `zoom`. Fixing `InputBar` alone left the diff, review-guide
    // and plan bars mis-tuned at any text preference other than 100%.
    expect(read('components/ui/prompt-composer/prompt-composer.svelte')).not.toContain('zoom:')
  })
})
