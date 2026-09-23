import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSurfaceBoundary } from '../../scripts/check-surface-boundary'

// WHY: the cloud console mounts the boards, a task, a work, and a session
// record with no WorkspaceContext at all (docs/plans/cloud-console-native-pages.md
// §4 and §9), so a
// `getWorkspaceContext()` that lands in one of those trees is a crash on the
// console and nothing on desktop. The lint is the only thing that fails first.
describe('surface boundary', () => {
  function withComponents(files: Record<string, string>, run: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'surface-boundary-'))
    try {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true })
        writeFileSync(join(root, path), body)
      }
      run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('a record surface that reads the workspace fails; one that reads the surface context passes', () => {
    withComponents({
      'work/WorkPane.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
      'tasks/task-page/TaskHeader.svelte': '<script>\n  const session = getSurfaceContext();\n  const cwd = session.workspace?.staticInfo;\n</script>',
      'conversation/MarkdownLink.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
      // A comment may name the read it replaced.
      'session/record/SessionRecordPage.svelte': '<script>\n  // was getWorkspaceContext()\n  const session = getSurfaceContext();\n</script>',
    }, (root) => {
      const failures = checkSurfaceBoundary(root)
      expect(failures.map((failure) => failure.path).sort()).toEqual(['conversation/MarkdownLink.svelte', 'work/WorkPane.svelte'])
    })
  })

  test('a workspace-only file behind a gate, and a transcript item, may read the workspace; a board may not', () => {
    withComponents({
      'tasks/task-page/TaskLinkPicker.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
      'prs/PrDetailPanel.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
      'conversation/TranscriptItem.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
    }, (root) => {
      expect(checkSurfaceBoundary(root)).toEqual([])
    })
    withComponents({
      'tasks/TasksPage.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
      'prs/PrsPage.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
      'workspace/WorkspacePage.svelte': '<script>\n  const session = getWorkspaceContext();\n</script>',
    }, (root) => {
      expect(checkSurfaceBoundary(root).map((failure) => failure.path).sort()).toEqual(['prs/PrsPage.svelte', 'tasks/TasksPage.svelte', 'workspace/WorkspacePage.svelte'])
    })
  })

  test('a portable surface still may not read the tab strip', () => {
    withComponents({
      'tasks/TasksPage.svelte': '<script>\n  const open = session.tabOrder.length;\n</script>',
    }, (root) => {
      expect(checkSurfaceBoundary(root).map((failure) => failure.detail)).toEqual(['reads tab state `.tabOrder`'])
    })
  })
})
