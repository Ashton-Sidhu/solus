import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ui = join(import.meta.dir, '../../packages/workspace-ui/src')
const read = (path: string) => readFileSync(join(ui, path), 'utf8')

const band = read('components/diff/ReviewPanelHeader.svelte')
const summary = read('components/diff/ChangeSummaryPopover.svelte')
const overflow = read('components/diff/ReviewPanelOverflowMenu.svelte')
const tabs = read('components/review/ReviewViewTabs.svelte')
const panel = read('components/diff/DiffPanel.svelte')
const pane = read('components/review/ReviewPane.svelte')
const guideView = read('components/pr-review/guide/GuideView.svelte')
const prBand = read('components/pr-review/PrPanelHeader.svelte')
const prOverflow = read('components/pr-review/PrPanelOverflowMenu.svelte')
const prTabs = read('components/pr-review/PrViewTabs.svelte')
const prPane = read('components/pr-review/PrReviewPane.svelte')

describe('review panel header — one band', () => {
  test('the band holds navigation and state, and configuration lives in the overflow', () => {
    // WHY: the whole point of 2b is that the band's slots never change. If
    // unified/split or refresh come back to the band, the row starts reflowing
    // with the active tab and the controls stop being learnable by position.
    expect(band).not.toContain('Unified')
    expect(band).not.toContain('Split')
    expect(band).not.toContain('Refresh diff')

    expect(overflow).toContain('Refresh diff')
    expect(overflow).toContain('SegmentedControl')
    expect(overflow).toContain('Hide file tree')
    expect(overflow).toContain('token highlighting')
  })

  test('the overflow is contextual and never empty', () => {
    // WHY: an absent or disabled trigger would make the *band* contextual —
    // the one thing 2b forbids. Refresh is on every view because every view
    // reads the same patch.
    expect(overflow).toContain('"Change map"')
    expect(overflow).toContain('"Walkthrough"')
    expect(overflow).toContain('"Diff view"')
    const refreshRow = overflow.indexOf('Refresh diff')
    const diffOnlyGate = overflow.indexOf('view === "diff" && hasFiles')
    expect(refreshRow).toBeGreaterThan(0)
    expect(refreshRow).toBeLessThan(diffOnlyGate)
  })

  test('the band owns the window pair, so the pane draws no floating chrome', () => {
    // WHY: two close buttons over one row is the bug the floating cluster plus
    // an in-content strip used to produce. The band is the only chrome now.
    expect(pane).not.toContain('PaneChrome')
    expect(band).toContain('aria-label="Close review"')
    expect(band).toContain('Maximize panel')
  })

  test('no rule under the band and no divider beside the panel', () => {
    // WHY: space separates, lines do not. Both rules were removed together —
    // a border-bottom here with no left border reads as a stack of bands.
    expect(band).not.toContain('border-b')
    expect(pane).not.toContain('bordered')
  })

  test('the change summary is a branch and two counts — no file count', () => {
    // WHY: the count answered a question nobody asked on a row this dense; the
    // file list behind the trigger answers the real one.
    expect(summary).toContain('+{additions}')
    expect(summary).toContain('−{deletions}')
    expect(summary).not.toMatch(/\{files\.length\}\s*(file|files)/)
    expect(band).not.toContain('headerStats.files')
  })

  test('the summary popover is a jump list with the base ref in its footer', () => {
    expect(summary).toContain('onOpenFile(file.path)')
    expect(summary).toContain('compared against')
    expect(band).not.toContain('compared against')
  })

  test('every rung is read off the panel, never the window', () => {
    // WHY: a review panel is legally ~356px wide beside a companion pane, so a
    // window-width or viewport reading here is wrong by the whole split.
    expect(band).toContain('@container/band')
    expect(band).not.toMatch(/\bmax-md:|\bmd:|isMobileViewport|innerWidth/)
    expect(tabs).toContain('/band:')
  })

  test('the tab group carries no track, no badges and takes the chrome rung', () => {
    expect(tabs).toContain('text-workspace-chrome')
    expect(tabs).not.toContain('rounded-full bg-[var(--wash-2)] p-0.5')
  })

  test('the review path is the only one that gets the band', () => {
    // WHY: the PR review pane draws its own header above the panel and takes
    // the quieter sub-row. Giving both the band would stack two headers.
    expect(panel).toContain('!!viewTabs && !hasHostHeaderRow && !embedded')
  })
})

describe('guide staleness lives in the header, not the narrative', () => {
  test('the guide intro dates itself and says nothing about being current', () => {
    // WHY: whether a guide still describes HEAD is the fact that decides
    // whether the narrative is worth reading. Burying it inside the narrative
    // meant you had to start reading to find out.
    expect(guideView).toContain('Generated {generatedTime')
    expect(guideView).not.toContain('New commits since guide')
    expect(guideView).not.toContain('Current')
    expect(guideView).not.toContain('onRegenerate')
  })

  test('both overflows carry the guide row, and flag it when stale', () => {
    for (const menu of [overflow, prOverflow]) {
      expect(menu).toContain('New commits since guide')
      expect(menu).toContain('Regenerate guide')
      // The dot rides on the trigger too, so staleness is visible at rest
      // without opening the menu — and without a slot that pushes the band.
      expect(menu).toContain('flagsStale')
    }
  })

  test('the stale cue never changes the band’s layout', () => {
    // WHY: 2b’s whole claim is that the slots hold still. A cue that reserves
    // or claims width would make the band contextual after all.
    for (const menu of [overflow, prOverflow]) {
      expect(menu).toMatch(/absolute[^"]*rounded-full bg-primary/)
    }
  })

  test('the PR route’s regenerate button carries the cue the guide lost', () => {
    // WHY: the page-shaped review keeps its own header, so the badge had to
    // land somewhere there too rather than simply disappearing.
    expect(prPane).toContain('guideLoader.stale')
    expect(prPane).toContain('"New commits since guide"')
  })
})

describe('the PR review panel takes the same band', () => {
  test('tabs lead, the queue scrubber is the turn scrubber, and space replaces the divider', () => {
    expect(prBand).toContain('@container/band')
    expect(prBand).toContain('aria-label="Review queue"')
    expect(prBand).toContain('bg-[var(--wash-2)]')
    // The seam under the band and the rule before the pane controls both go.
    expect(prBand).not.toContain('border-b')
    expect(prBand).not.toMatch(/w-px shrink-0 bg-\[var\(--hairline/)
  })

  test('once-a-session commands moved off the band into the overflow', () => {
    expect(prOverflow).toContain('Refresh pull request')
    expect(prOverflow).toContain('Open pull request page')
    // The band draws neither itself: it hands both to the overflow and keeps
    // only what states the PR or acts on it in the moment.
    expect(prBand).not.toContain('Open pull request page')
    expect(prBand).not.toContain('Refresh pull request')
    expect(prBand).not.toContain('ArrowClockwiseIcon')
    expect(prBand).toContain('<PrPanelOverflowMenu {tab} {onRefresh}')
    expect(prPane).toContain('onRefresh={() => void refreshPr()}')
    expect(prPane).toContain('guide={guideHeaderActions}')
  })

  test('both reviews use one tab group shape', () => {
    // WHY: reading a pull request and reading a branch are the same job. The
    // control that switches views must not change shape between them.
    for (const group of [tabs, prTabs]) {
      expect(group).toContain('text-workspace-chrome')
      expect(group).toContain('rounded-lg px-2 text-workspace-chrome')
      expect(group).toContain('@min-[53.75rem]/band:px-3')
      expect(group).toContain("'bg-[var(--wash-2)] font-medium text-foreground'")
      expect(group).not.toContain('rounded-full bg-[var(--wash-2)] p-0.5')
    }
  })
})
