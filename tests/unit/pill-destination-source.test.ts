import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const read = (path: string) => readFileSync(join(import.meta.dir, '../../src', path), 'utf8')

const pillSource = read('renderer/components/layout/PillLayout.svelte')
const toolbarSource = read('renderer/components/input/InputToolbar.svelte')
const statusBarSource = read('renderer/components/layout/StatusBarControls.svelte')

describe('pill destination row', () => {
  test('is addressed by the session being composed, not the active tab', () => {
    // WHY: the pill has no destination strip of its own — this row is the only
    // place it says which project, host, and branch the next session starts in.
    // Addressed by a tab id alone it fell back to the workspace defaults while a
    // draft led, so the folder read as the workspace whatever the user chose.
    expect(pillSource).toContain('draftId={pillDraft?.id}')
    expect(toolbarSource).toContain('sourceId={tabId ?? draftId}')
    expect(statusBarSource).toContain('const run = $derived(session.runFor(source))')
    expect(statusBarSource).toContain('const ctx = $derived(statusBar.ctxForRun(run))')
  })

  test('lands every destination choice on that same source', () => {
    // WHY: a draft owns the run the choice belongs to, and the workspace
    // commands below all resolve a tab id or a draft id. Reading the draft while
    // writing the active tab would show one destination and start another.
    expect(statusBarSource).toContain('session.switchToBranch(branch, source)')
    expect(statusBarSource).toContain('session.switchToWorktree(worktree.path, source)')
    expect(statusBarSource).toContain('session.setDispatchWorktree(worktree, source)')
    expect(statusBarSource).toContain('session.setDispatchBaseBranch(baseBranch, source)')
    // The Open project flow re-aims the requester rather than minting a second
    // draft, which would orphan the prompt already typed into the pill.
    expect(statusBarSource).toContain('"solus:open-project", { detail: { tabId: source } }')
  })
})
