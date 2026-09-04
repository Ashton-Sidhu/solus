import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const projectPanel = readFileSync(
  join(root, 'packages/workspace-ui/src/components/project-panel/ProjectPanel.svelte'),
  'utf8',
)
const gitSection = readFileSync(
  join(root, 'packages/workspace-ui/src/components/project-panel/GitSection.svelte'),
  'utf8',
)
const linkedRows = readFileSync(
  join(root, 'packages/workspace-ui/src/components/project-panel/LinkedPullRequestRows.svelte'),
  'utf8',
)

describe('Git rail pull request freshness', () => {
  test('refreshes only while the owning project rail is visible', () => {
    // WHY: tabs remain mounted when hidden. Polling every mounted Git rail would
    // multiply code-host traffic with the number of conversations left open.
    expect(projectPanel).toContain('<GitSection {sourceId} active={active && open} />')
    expect(gitSection).toContain('{active}')
    expect(linkedRows).toContain('if (!active) return;')
    expect(linkedRows).toContain('document.visibilityState === "visible"')
  })

  test('revalidates on visibility, focus, push, and a bounded fallback', () => {
    // WHY: mergeability changes outside Solus and after a push. The compact row
    // must not remain a mount-time snapshot until the user attempts the merge.
    expect(linkedRows).toContain('pullRequest.loadDetail({ force: true })')
    expect(linkedRows).toContain('<svelte:window onfocus={refreshOnWindowFocus} />')
    expect(linkedRows).toContain('const DETAIL_REFRESH_INTERVAL_MS = 30_000;')
    expect(gitSection).toContain('pushCompleted={actions.lastResult?.push.status === "pushed"}')
    expect(linkedRows).toContain('if (!active || !pushCompleted) return;')
    expect(linkedRows).toContain('void refreshDetail(true)')
  })

  test('uses the visible check state when it decides whether to show merge', () => {
    // WHY: the project-panel row is separate from the PR-page status card. It
    // must pass its own live check result into the same decision it uses before
    // and after the final host refresh.
    expect(linkedRows).toContain('linkedPrPrimaryAction(detail, checks?.state)')
    expect(linkedRows).toContain('linkedPrPrimaryAction(refreshed, checks?.state)')
  })
})
