import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { PAGE_ICON_BTN } from '@solus/workspace-ui/lib/page-chrome'

// The pane's chrome cluster (PaneChrome) floats over the top-right of the pane
// content, so nothing below it knows it is there. Every in-content top strip —
// the document header, the diagram control strip, their skeletons — reserves it
// as padding via `--solus-pane-chrome-inset`. If that reserve is smaller than
// the cluster's real box, the strip's last control slides *under* the first
// chrome icon: which is exactly what a work pane's "Ask Solus" pill did while
// the reserve stood at 5.5rem against a 6rem cluster.

const REM = 16

const workspaceBody = readFileSync(
  new URL('@solus/workspace-ui/components/layout/WorkspaceBody.svelte', import.meta.url),
  'utf8',
)
const paneChrome = readFileSync(
  new URL('@solus/workspace-ui/components/ui/PaneChrome.svelte', import.meta.url),
  'utf8',
)

/** Every `--solus-pane-chrome-inset` the pane columns publish, in px. */
function publishedInsets(): number[] {
  const matches = [...workspaceBody.matchAll(/--solus-pane-chrome-inset:\s*([\d.]+)rem/g)]
  expect(matches.length).toBeGreaterThan(0)
  return matches.map((m) => Number(m[1]) * REM)
}

/** The cluster's own box: right inset + N buttons + the gaps between them. */
function clusterWidth(buttonSize: number, buttons: number): number {
  const rightInset = 0.625 * REM // right-2.5 on the cluster
  const gap = 0.25 * REM // gap-1 between buttons
  return rightInset + buttons * buttonSize + (buttons - 1) * gap
}

describe('pane chrome inset', () => {
  test('reserves at least the room the chrome cluster occupies', () => {
    // WHY: a work pane always renders three controls (open-in-split, maximize,
    // close), which is the widest the cluster gets without a `trailing` extra.
    expect(paneChrome).toContain('right-2.5')
    expect(paneChrome).toContain('gap-1')

    const fine = clusterWidth(1.625 * REM, 3) // size-[1.625rem] in PAGE_ICON_BTN
    const coarse = clusterWidth(2.75 * REM, 3) // size-11 at pointer: coarse
    expect(PAGE_ICON_BTN).toContain('size-[1.625rem]')
    expect(PAGE_ICON_BTN).toContain('[@media(pointer:coarse)]:size-11')

    const insets = publishedInsets()
    // The pointer-agnostic reserve is the smallest one published; the coarse
    // override is the largest.
    expect(Math.min(...insets)).toBeGreaterThanOrEqual(fine)
    expect(Math.max(...insets)).toBeGreaterThanOrEqual(coarse)
  })
})
