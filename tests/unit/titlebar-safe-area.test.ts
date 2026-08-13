import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const mainSource = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const cssSource = readFileSync(join(root, 'src/renderer/index.css'), 'utf8')
const breadcrumbSource = readFileSync(
  join(root, 'src/renderer/components/conversation/SessionBreadcrumb.svelte'),
  'utf8',
)
const workspaceSource = readFileSync(
  join(root, 'src/renderer/components/workspace/WorkspacePage.svelte'),
  'utf8',
)
const workspaceBodySource = readFileSync(
  join(root, 'src/renderer/components/layout/WorkspaceBody.svelte'),
  'utf8',
)
const listPageSource = readFileSync(
  join(root, 'src/renderer/components/ui/list-page/ListPage.svelte'),
  'utf8',
)
const projectPanelSource = readFileSync(
  join(root, 'src/renderer/components/project-panel/ProjectPanel.svelte'),
  'utf8',
)
const panelSectionSource = readFileSync(
  join(root, 'src/renderer/components/project-panel/PanelSection.svelte'),
  'utf8',
)
const sidePanelSource = readFileSync(
  join(root, 'src/renderer/components/layout/SidePanel.svelte'),
  'utf8',
)
const titlebarSurfacePaths = [
  'src/renderer/components/ui/list-page/ListPage.svelte',
  'src/renderer/components/workspace/WorkspacePage.svelte',
  'src/renderer/components/automations/AutomationBuilder.svelte',
  'src/renderer/components/conversation/ConversationPaneSkeleton.svelte',
  'src/renderer/components/conversation/SubagentPane.svelte',
  'src/renderer/components/diagram/DiagramShell.svelte',
  'src/renderer/components/diff/DiffToolbar.svelte',
  'src/renderer/components/document-shell/DocumentShell.svelte',
  'src/renderer/components/files/FileEditorPane.svelte',
  'src/renderer/components/files/FilesPane.svelte',
  'src/renderer/components/layout/AsidePaneShell.svelte',
  'src/renderer/components/layout/SidePanel.svelte',
  'src/renderer/components/project-panel/PanelSection.svelte',
  'src/renderer/components/pr-review/PrDiffPane.svelte',
  'src/renderer/components/pr-review/PrPanelHeader.svelte',
  'src/renderer/components/pr-review/PrReviewPane.svelte',
  'src/renderer/components/review/ReviewGuidePane.svelte',
  'src/renderer/components/review-mode/ReviewModeHost.svelte',
  'src/renderer/components/settings/SettingsPage.svelte',
  'src/renderer/components/settings/SettingsPageSkeleton.svelte',
  'src/renderer/components/tasks/task-page/TaskChromeBar.svelte',
  'src/renderer/components/ui/Pane.svelte',
] as const
describe('macOS editor titlebar', () => {
  test('keeps the edge-to-edge hiddenInset design', () => {
    expect(mainSource).toContain("windowOptions.titleBarStyle = 'hiddenInset'")
    expect(mainSource).toContain(
      'windowOptions.trafficLightPosition = { x: 16, y: 18 }',
    )
    expect(mainSource).not.toContain("titleBarStyle = 'default'")
  })

  test('does not maintain the rejected page-level drag contract', () => {
    expect(cssSource).not.toContain('.titlebar-drag-region')
    expect(cssSource).toMatch(
      /html\.is-mac-editor\s*{[^}]*--solus-titlebar-height:\s*3\.25rem;[^}]*--solus-traffic-light-inset:\s*5\.625rem;/,
    )
  })

  test('uses one shared draggable topbar contract on every editor surface', () => {
    expect(cssSource).toMatch(
      /html\.is-mac-editor \.workspace-titlebar\s*{[^}]*-webkit-app-region:\s*drag;/,
    )
    expect(cssSource).toMatch(
      /\.workspace-titlebar[\s\S]*:where\(button, input, textarea, select, a, \[contenteditable="true"\]\)[^{]*{[^}]*-webkit-app-region:\s*no-drag;/,
    )
    for (const path of titlebarSurfacePaths) {
      expect(readFileSync(join(root, path), 'utf8'), path).toContain(
        'workspace-titlebar',
      )
    }
  })

  test('puts the contract on visible breadcrumb and page header hit targets', () => {
    // WHY: an absolute drag strip behind visible content loses Electron hit
    // testing. The row the user can see must own the app region itself.
    expect(breadcrumbSource).toContain(
      'class="workspace-titlebar crumb-band',
    )
    expect(workspaceSource).toContain(
      'class="workspace-titlebar flex shrink-0 items-end',
    )
    expect(listPageSource).toContain(
      'class="workspace-titlebar flex shrink-0 items-end',
    )
    expect(workspaceSource).not.toContain(
      'workspace-titlebar absolute inset-x-0 top-0',
    )
    expect(listPageSource).not.toContain(
      'workspace-titlebar absolute inset-x-0 top-0',
    )
    expect(workspaceBodySource).not.toContain(
      'conversation-pool flex flex-col min-h-0 no-drag',
    )
  })

  test('keeps project cards at the top and makes the first card the drag owner', () => {
    // WHY: a dedicated 52px drag element moved the project cards down and left
    // a blank band. The visible Environment card must occupy and own that area.
    expect(projectPanelSource).toContain('title="Environment"')
    expect(projectPanelSource).toMatch(/title="Environment"[\s\S]*?titlebar/)
    expect(projectPanelSource).not.toContain(
      'class="workspace-titlebar h-(--solus-titlebar-height) shrink-0"',
    )
    expect(panelSectionSource).toContain("? 'workspace-titlebar'")
    expect(panelSectionSource).toContain(
      'class="no-drag min-h-0 pt-1.5"',
    )
  })

  test('keeps the session header outside the sidebar no-drag island', () => {
    // WHY: a no-drag panel root prevents its child header from becoming an
    // Electron drag target. Only the interactive session list opts out.
    expect(sidePanelSource).not.toContain('side-panel-root no-drag')
    expect(sidePanelSource).toContain(
      `<Sidebar.Content class="overflow-hidden {side === 'left' ? 'no-drag' : ''}">`,
    )
    expect(sidePanelSource).toContain(
      "? 'side-panel-header--mac-left workspace-titlebar'",
    )
    expect(sidePanelSource).toContain(
      'margin-bottom: calc(0px - var(--side-panel-window-inset) - 0.625rem)',
    )
  })
})
