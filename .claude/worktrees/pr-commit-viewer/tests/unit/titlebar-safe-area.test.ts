import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const mainSource = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const cssSource = readFileSync(join(root, 'src/renderer/index.css'), 'utf8')
const workspaceSource = readFileSync(
  join(root, 'src/renderer/components/layout/WorkspaceBody.svelte'),
  'utf8',
)
const alignedHeaderSources = [
  // The header a conversation and a draft beside the leading pane both wear.
  'src/renderer/components/layout/AsidePaneShell.svelte',
  'src/renderer/components/conversation/SubagentPane.svelte',
  'src/renderer/components/diff/DiffToolbar.svelte',
  'src/renderer/components/files/FileEditorPane.svelte',
  'src/renderer/components/files/FilesPane.svelte',
  'src/renderer/components/pr-review/PrReviewPane.svelte',
  'src/renderer/components/tasks/task-page/TaskChromeBar.svelte',
  'src/renderer/components/document-shell/DocumentShell.svelte',
  'src/renderer/components/review-mode/ReviewModeHost.svelte',
  'src/renderer/components/automations/AutomationBuilder.svelte',
  'src/renderer/components/layout/SidePanel.svelte',
].map((path) => ({ path, source: readFileSync(join(root, path), 'utf8') }))
const sidePanelSource = readFileSync(
  join(root, 'src/renderer/components/layout/SidePanel.svelte'),
  'utf8',
)

describe('macOS titlebar safe area', () => {
  test('shares one 52px centerline with the native traffic lights', () => {
    // WHY: Electron's default hiddenInset placement and an independently sized
    // renderer header drift apart. Pin both sides of the native/renderer seam.
    expect(mainSource).toContain("titleBarStyle: 'hiddenInset' as const")
    expect(mainSource).toContain('trafficLightPosition: { x: 16, y: 18 }')
    expect(cssSource).toMatch(
      /html\.is-mac-editor\s*{[^}]*--solus-titlebar-height:\s*3\.25rem;[^}]*--solus-traffic-light-inset:\s*5\.625rem;/,
    )
  })

  test('derives header content from the complete toggle geometry', () => {
    // The safe content edge is 90px + 28px + 12px = 130px. Keeping the
    // expression symbolic makes later control-size changes move every header.
    expect(cssSource).toContain('--solus-titlebar-control-size: 1.75rem')
    expect(cssSource).toContain('--solus-titlebar-control-gap: 0.75rem')
    expect(cssSource).toMatch(
      /--solus-titlebar-content-inset:\s*calc\([\s\S]*var\(--solus-titlebar-control-left\)[\s\S]*var\(--solus-titlebar-control-size\)[\s\S]*var\(--solus-titlebar-control-gap\)[\s\S]*\);/,
    )
  })

  test('gives the toggle and adjacent headers different anchors', () => {
    // A shared 90px inset puts both at the same x and lets a long breadcrumb
    // paint underneath the toggle. The control starts at 90px; content at 130px.
    expect(workspaceSource).toContain(
      'left-[var(--solus-chrome-control-left,var(--solus-titlebar-control-left))]',
    )
    expect(workspaceSource).toContain(
      '<FrameExpandButton variant="sidebar" size="header" />',
    )
    expect(workspaceSource).toContain(
      '--solus-chrome-control-left: var(--solus-titlebar-control-left)',
    )
    expect(workspaceSource).toContain(
      '--solus-chrome-lead-inset: var(--solus-titlebar-content-inset)',
    )
  })

  test('puts every pane header on the titlebar centerline', () => {
    // WHY: independently sized 40px, 48px, intrinsic, and 52px rows produced
    // visibly staggered breadcrumbs and controls across adjacent panes.
    expect(cssSource).toContain('--solus-chrome-row-h: 2.5rem')
    expect(cssSource).toMatch(
      /html\.is-mac-editor\s*{[^}]*--solus-titlebar-height:\s*3\.25rem;[^}]*--solus-traffic-light-inset:\s*5\.625rem;[^}]*--solus-chrome-row-h:\s*var\(--solus-titlebar-height\);/,
    )
    for (const header of alignedHeaderSources) {
      expect(header.source, header.path).toContain('--solus-chrome-row-h')
    }
  })

  test('does not optically lift titlebar-aware content above that centerline', () => {
    // WHY: PR breadcrumbs carried a historic -2px nudge while Task and document
    // chrome used shorter rows, so all three looked high beside the stoplights.
    const prChrome = readFileSync(
      join(root, 'src/renderer/components/pr-review/PrDetailChrome.svelte'),
      'utf8',
    )
    expect(prChrome).not.toContain('-translate-y-0.5')
  })

  test('cancels the inset panel shell offset for the open session sidebar', () => {
    // The rounded sidebar is inset 4px and its border paints 1px inward. If its
    // 52px row starts from that local origin, the collapse control sits 5px
    // below the native stoplights even though both rows have the same height.
    expect(sidePanelSource).toContain('--side-panel-window-inset: 5px')
    expect(sidePanelSource).toContain(
      'top: calc(0px - var(--side-panel-window-inset))',
    )
    expect(sidePanelSource).toContain(
      'margin-bottom: calc(0px - var(--side-panel-window-inset))',
    )
    expect(sidePanelSource).toContain(
      'size-[var(--solus-titlebar-control-size)]',
    )
  })
})
