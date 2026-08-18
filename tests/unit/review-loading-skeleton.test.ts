import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const paneSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/ui/Pane.svelte'),
  'utf8',
)
const reviewSurfaceSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/review/ReviewSurface.svelte'),
  'utf8',
)
const reviewPaneSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/review/ReviewPane.svelte'),
  'utf8',
)
const workspaceBodySource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/layout/WorkspaceBody.svelte'),
  'utf8',
)
const diffPanelSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/diff/DiffPanel.svelte'),
  'utf8',
)
const reviewLoadingSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/review/ReviewLoadingSurface.svelte'),
  'utf8',
)

describe('review pane loading state', () => {
  test('uses one loading surface across both loading boundaries', () => {
    // WHY: separate placeholders drifted in toolbar height and background,
    // making each ownership handoff visible even when the content matched.
    expect(paneSource).toMatch(
      /ref\.name === "review"[\s\S]*<ReviewLoadingSurface view={ref\.params\.view \?\? "diff"}/,
    )
    expect(reviewSurfaceSource).toContain('<ReviewLoadingSurface {view} />')
    expect(reviewLoadingSource).toContain('bg-(--solus-container-bg)')
    expect(reviewLoadingSource).toContain('h-(--solus-chrome-row-h,2.5rem)')
    expect(reviewLoadingSource).toContain('<DiffLoadingSkeleton')
  })

  test('keeps the lazy-loading review dismissible', () => {
    expect(paneSource).toMatch(
      /ref\.name === "review"[\s\S]*<PaneChrome[\s\S]*onClose={actions\.closeOverlay}/,
    )
  })

  test('mounts the review outlet without the generic companion delay', () => {
    // WHY: delaying the outlet required a second temporary skeleton which was
    // destroyed 90ms later. Mounting the async outlet is cheap and keeps one
    // loading surface in control from the first frame.
    expect(workspaceBodySource).toMatch(
      /{#if companions\.settled\.has\(pane\.id\) \|\| ref\?\.name === "review"}/,
    )
    expect(workspaceBodySource).not.toContain(
      'import DiffLoadingSkeleton from "../diff/DiffLoadingSkeleton.svelte";',
    )
  })

  test('keeps the skeleton visible when the route module takes ownership', () => {
    // WHY: the route boundary already painted a skeleton. Replacing it with
    // DiffPanel's normal 120ms blank delay causes a visible flash.
    expect(reviewPaneSource).toContain('initialSkeletonVisible')
    expect(diffPanelSource).toContain(
      'let showLoading = $state(untrack(() => initialSkeletonVisible));',
    )
    expect(diffPanelSource).toMatch(
      /if \(diffState\.loading\) \{\s*if \(showLoading\) return;/,
    )
  })

  test('does not fade the mounted review over its visible skeleton', () => {
    // WHY: the generic companion reveal starts at opacity zero. The review has
    // already painted its skeleton, so that reveal creates a blank frame.
    expect(workspaceBodySource).toContain(
      'class:secondary-pane-content--continuous={ref?.name === "review"}',
    )
    expect(workspaceBodySource).toMatch(
      /\.secondary-pane-content--continuous \{\s*animation: none;/,
    )
  })
})
