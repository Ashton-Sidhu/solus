import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { defaultStartProject } from '@solus/workspace-ui/contexts/workspace/run-config'

/**
 * Where a new session starts. ⌘N used to land in `~/.solus/my-workspace` when
 * it was pressed on an empty draft: the empty draft was dropped before the new
 * one read its project from it, so the new one fell through to the workspace.
 * And the workspace was the only fallback there was, however recently the user
 * had worked in a project.
 */

const WORKSPACE = { serverId: 'local', directory: '/Users/me/.solus/my-workspace' }
const LAST = { serverId: 'studio', directory: '/code/solus' }

describe('the project a session starts in when nothing on screen names one', () => {
  test('is the project the last session started in', () => {
    expect(defaultStartProject(LAST, () => false, WORKSPACE)).toEqual(LAST)
  })

  test('is the workspace before any session has started', () => {
    expect(defaultStartProject(null, () => false, WORKSPACE)).toEqual(WORKSPACE)
  })

  test('is the workspace while the last project’s host is known to be down', () => {
    // A path names a folder on one machine only; a draft aimed at a host that
    // is down could not start, so the workspace on the default host stands in.
    expect(defaultStartProject(LAST, (serverId) => serverId === 'studio', WORKSPACE)).toEqual(WORKSPACE)
  })
})

// ─── ⌘N through the drafts controller ───

mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: { statusFor: () => 'online', isolatesSessions: () => false },
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
    permissionMode: 'auto',
    provider: 'claude-code',
    serverId: 'local',
    taskServerId: 'local',
    projectGroupPath: null,
    sessionSkills: [],
    pendingHostDispatch: null,
  }
}

/** One pane, and the workspace members the drafts controller reads. */
function draftsInOnePane() {
  type Base = { name: string; params: { draftId: string } } | null
  const pane = { id: 'lead', base: null as Base }
  let drafts: InstanceType<typeof SessionDrafts>
  const workspace = {
    activeTabId: '',
    defaultRunConfig: runIn(WORKSPACE.directory),
    get focusedSourceId() {
      return pane.base?.name === 'draft' ? pane.base.params.draftId : null
    },
    runFor: (sourceId: string) => drafts.sessionDrafts.get(sourceId)?.run,
    rootTaskIdFor: () => null,
    opening: { moveToRunOnHost: () => {} },
    settings: { tasksEnabled: true },
    router: {
      focusedPaneId: pane.id,
      panes: [pane],
      pane: () => pane,
      navigate: (ref: Base) => { pane.base = ref },
    },
  }
  drafts = new SessionDrafts(workspace as never)
  return drafts
}

describe('⌘N', () => {
  test('from an empty draft keeps that draft’s project', () => {
    const drafts = draftsInOnePane()
    const empty = drafts.openSessionDraft({}, '/code/solus')

    const next = drafts.openSessionDraft({ freshTask: true, via: 'keybinding' })

    expect(next.run.workingDirectory).toBe('/code/solus')
    // The empty draft it replaced is still let go of: nothing lists it.
    expect(drafts.sessionDrafts.has(empty.id)).toBe(false)
  })

  test('from a written-in draft keeps its project and keeps the draft', () => {
    const drafts = draftsInOnePane()
    const written = drafts.openSessionDraft({}, '/code/solus')
    written.prompt.text = 'half a thought'

    const next = drafts.openSessionDraft({ freshTask: true, via: 'keybinding' })

    expect(next.run.workingDirectory).toBe('/code/solus')
    expect(drafts.sessionDrafts.has(written.id)).toBe(true)
  })
})
