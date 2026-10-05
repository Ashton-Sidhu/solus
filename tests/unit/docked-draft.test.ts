import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { leadingHomeRoute } from '@solus/workspace-ui/contexts/workspace/leading-home'

/**
 * A page's docked composer (documents, artifacts, diagrams, pull requests)
 * writes into a draft that no pane shows. The user is typing in it all the
 * same, so nothing else may claim it, and the words must outlive the page.
 */

mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: { statusFor: () => 'online' },
}))
mock.module('@solus/workspace-ui/lib/git-actions.svelte', () => ({ disposeGitActions: () => {} }))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let SessionDrafts: typeof import('@solus/workspace-ui/contexts/workspace/session-drafts.svelte')['SessionDrafts']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;({ SessionDrafts } = await import('@solus/workspace-ui/contexts/workspace/session-drafts.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function runIn(workingDirectory: string): RunConfig {
  return {
    workingDirectory,
    gitContext: null,
    worktree: null,
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'full-access',
    provider: 'claude-code',
    serverId: 'local',
    taskServerId: 'local',
    projectGroupPath: null,
    sessionSkills: [],
    pendingHostDispatch: null,
  }
}

/** One pane showing a work page, and the workspace members the controller reads. */
function draftsBesideAWorkPage() {
  const pane = { id: 'lead', base: { name: 'work', params: { workId: 'w1' } } }
  let drafts: InstanceType<typeof SessionDrafts>
  const workspace = {
    settings: { modelOptionsByProvider: {} },
    activeTabId: '',
    defaultRunConfig: runIn('/Users/me/.solus/my-workspace'),
    focusedSourceId: null,
    runFor: () => undefined,
    rootTaskIdFor: () => null,
    opening: { moveToRunOnHost: () => {} },
    router: { focusedPaneId: pane.id, panes: [pane], pane: () => pane, navigate: () => {} },
  }
  drafts = new SessionDrafts(workspace as never)
  return drafts
}

describe('a page’s docked draft', () => {
  test('is aimed at what the page is', () => {
    const drafts = draftsBesideAWorkPage()

    const docked = drafts.openDockedDraft({ freshTask: true, workId: 'w1' }, '/code/solus')

    // WHY: Send must start a session that already knows the work it is about
    // and runs in the work's project, with no second step to bind them.
    expect(docked.boundWorkId).toBe('w1')
    expect(docked.run.workingDirectory).toBe('/code/solus')
  })

  test('is not taken as the leading pane’s home while the page holds it', () => {
    const drafts = draftsBesideAWorkPage()
    const docked = drafts.openDockedDraft({ freshTask: true, workId: 'w1' }, '/code/solus')
    docked.prompt.text = 'tighten the intro'

    const home = leadingHomeRoute({
      hasTabs: false,
      leadingBase: null,
      drafts: drafts.sessionDrafts,
      composingDraftIds: drafts.composingDraftIds,
      createDraft: () => drafts.createSessionDraft({}),
    })

    // WHY: closing some other page must not pull the words out from under the
    // docked composer the user is typing in, into a second composer.
    expect(home.name).toBe('draft')
    expect(home.name === 'draft' && home.params.draftId).not.toBe(docked.id)
  })

  test('folded empty leaves nothing behind', () => {
    const drafts = draftsBesideAWorkPage()
    const docked = drafts.openDockedDraft({ freshTask: true, workId: 'w1' })

    drafts.undockDraft(docked.id)

    // WHY: opening the composer and backing out is not a draft the user has.
    expect(drafts.sessionDrafts.has(docked.id)).toBe(false)
  })

  test('left with words in it becomes a draft the sidebar lists', () => {
    const drafts = draftsBesideAWorkPage()
    const docked = drafts.openDockedDraft({ freshTask: true, workId: 'w1' })
    docked.prompt.text = 'half a thought'

    drafts.undockDraft(docked.id)

    // WHY: closing the page must not lose what was typed; the sidebar lists a
    // draft once nothing is composing it, and that row is the way back.
    expect(drafts.sessionDrafts.has(docked.id)).toBe(true)
    expect(drafts.composingDraftIds.has(docked.id)).toBe(false)
  })
})
