import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workspaceSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)
const workPaneSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/work/WorkPane.svelte'),
  'utf8',
)

describe('closing a work', () => {
  test('restores a draft composer when there is no session tab to reveal', () => {
    // WHY: the chat pool has no content without a tab. Returning a work to that
    // route exposes a blank workspace with only the docked input instead of the
    // full new-session composer.
    expect(workspaceSource).toContain('if (this.tabOrder.some((tabId) => !!this.tabs[tabId]))')
    expect(workspaceSource).toContain('if (latestDraft) this.openDraft(latestDraft.id)')
    expect(workspaceSource).toContain("else this.openSessionDraft({ target: this.router.leadingPane.id, via: 'click' })")
  })

  test('uses the same exit policy for every work type and delete', () => {
    // Documents, diagrams, artifacts, and delete all close through WorkPane.
    // One path must not regress to the router's empty-chat fallback.
    expect(workPaneSource).toContain('session.closeWork(paneId);')
    expect(workPaneSource.match(/onClose=\{handleClose\}/g)).toHaveLength(4)
    expect(workPaneSource).toContain('handleClose();\n    session.requestWorkDelete(target);')
  })
})
