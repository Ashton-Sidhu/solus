import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { RunConfig, SessionSpec } from '@solus/contracts/types'
import { adoptGit, checkoutPlace, dispatchTo, folderLocation, openFolder } from '@solus/workspace-ui/contexts/workspace/run-location'

/**
 * A draft owns where it runs (docs/plans/run-location.md §10). Every move goes
 * through `moveTo`, and the drafts store asks the host for the new checkout once
 * per place. No effect watches the run, so a Git answer landing on the draft —
 * which keeps the place — must never start another read.
 */

mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: { readinessFor: () => ({ readiness: 'ready', away: false, unreachableReason: null, refusedReason: null, lastSeenAt: null }) },
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

function runIn(workingDirectory: string, serverId = 'local'): RunConfig {
  return {
    location: folderLocation({ serverId, path: workingDirectory }),
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'full-access',
    provider: 'claude-code',
    sessionSkills: [],
  }
}

/** The drafts store with a workspace that records every checkout read. */
function draftsThatRecordReads() {
  const pane = { id: 'lead', surfaces: [] as { name: string; params: { draftId: string } }[], activeSurfaceIndex: 0 }
  const reads: string[] = []
  const workspace = {
    settings: { modelOptionsByProvider: {} },
    activeTabId: '',
    defaultRunConfig: runIn('/Users/me/workspace'),
    focusedSourceId: null,
    runFor: () => undefined,
    rootTaskIdFor: () => null,
    opening: { moveToRunOnHost: () => {} },
    refreshStartTarget: async (_draftId: string, path: string, worktree: boolean) => {
      reads.push(worktree ? `${path} (worktree)` : path)
    },
    router: {
      focusedPaneId: pane.id,
      panes: [pane],
      leadingPane: pane,
      storedSurfaces: [],
      pane: () => pane,
      navigate: () => {},
      dropStrip: () => {},
    },
  }
  return { drafts: new SessionDrafts(workspace as never), reads }
}

const outsideGit = { serverId: 'local', path: '/tmp/notes' }

describe('a draft’s checkout', () => {
  test('is read once when the draft is made', () => {
    const { drafts, reads } = draftsThatRecordReads()
    drafts.createSessionDraft({ freshTask: true }, '/code/solus')
    expect(reads).toEqual(['/code/solus'])
  })

  test('outside Git is read once, however often the answer lands', () => {
    // WHY: the answer for a folder outside Git is `null`. It used to land as a
    // new location, which woke the effect that asked again — a read loop that
    // also re-sent getPluginCommands until the host refused more requests.
    const { drafts, reads } = draftsThatRecordReads()
    const draft = drafts.createSessionDraft({ freshTask: true }, outsideGit.path)
    for (let answer = 0; answer < 3; answer++) {
      draft.moveTo(adoptGit(draft.run.location, outsideGit, null, null))
      draft.moveTo({ ...draft.run.location })
    }
    expect(reads).toEqual([outsideGit.path])
  })

  test('is read again for each new place, and for the worktree choice', () => {
    const { drafts, reads } = draftsThatRecordReads()
    const draft = drafts.createSessionDraft({ freshTask: true }, '/code/solus')
    draft.moveTo(openFolder(draft.run.location, { serverId: 'local', path: '/code/site' }))
    draft.moveTo(openFolder(draft.run.location, { serverId: 'local', path: '/code/solus' }))
    draft.moveTo(folderLocation(checkoutPlace(draft.run), { newWorktree: { baseBranch: null } }))
    expect(reads).toEqual(['/code/solus', '/code/site', '/code/solus', '/code/solus (worktree)'])
  })

  test('is read again when a move drops a Git answer, even to the same folder', () => {
    // WHY: opening a folder starts with no Git; with no read, the branch and
    // worktree chips would stay empty for a repository the host already knew.
    const { drafts, reads } = draftsThatRecordReads()
    const draft = drafts.createSessionDraft({ freshTask: true }, '/code/solus')
    draft.moveTo(adoptGit(draft.run.location, { serverId: 'local', path: '/code/solus' }, { repoRoot: '/code/solus', branch: 'main', targetBranch: 'main' }))
    draft.moveTo(openFolder(draft.run.location, { serverId: 'local', path: '/code/solus' }))
    expect(reads).toEqual(['/code/solus', '/code/solus'])
  })

  test('is not read for a clone or a draft with no folder', () => {
    const { drafts, reads } = draftsThatRecordReads()
    const chat = drafts.createSessionDraft({ freshTask: true }, '~')
    const draft = drafts.createSessionDraft({ freshTask: true }, '/code/solus')
    draft.moveTo(dispatchTo(draft.run.location, 'cloud-box', 'github.com/acme/solus'))
    expect(checkoutPlace(chat.run).path).toBe('~')
    expect(reads).toEqual(['/code/solus'])
  })

  test('is read again for the drafts on a host that connects', () => {
    // WHY: a read while the host was away could not answer; the draft would
    // otherwise show no destination until the user moved it.
    const { drafts, reads } = draftsThatRecordReads()
    drafts.createSessionDraft({ freshTask: true, serverId: 'cloud-box' }, '/home/me/solus')
    drafts.createSessionDraft({ freshTask: true }, '/code/solus')
    reads.length = 0
    drafts.rereadStartTargets('cloud-box')
    expect(reads).toEqual(['/home/me/solus'])
  })

  test('is read for a restored draft, not for an empty one', () => {
    const { drafts, reads } = draftsThatRecordReads()
    const spec = (text: string, path: string): SessionSpec => ({
      prompt: { text, attachments: [] } as unknown as SessionSpec['prompt'],
      run: runIn(path),
      task: { kind: 'none' },
      boundWorkId: null,
      prReview: null,
    })
    drafts.restoreSessionDrafts({
      order: ['written', 'empty'],
      drafts: { written: spec('fix the build', '/code/solus'), empty: spec('', '/code/site') },
    })
    expect([...drafts.sessionDrafts.keys()]).toEqual(['written'])
    expect(reads).toEqual(['/code/solus'])
  })
})
