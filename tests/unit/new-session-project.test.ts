import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { defaultStartProject } from '@solus/workspace-ui/contexts/workspace/run-config'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'

/**
 * Where a new session starts. ⌘N used to land in the chat folder when it was
 * pressed on an empty draft: the empty draft was dropped before the new one
 * read its project from it, so the new one fell through to the fallback. And
 * that fallback was the only one there was, however recently the user had
 * worked in a project. The fallback is now a new chat.
 */

const NEW_CHAT = { serverId: 'local', directory: NEW_CHAT_DIRECTORY }
const LAST = { serverId: 'studio', directory: '/code/solus' }

describe('the project a session starts in when nothing on screen names one', () => {
  test('is the project the last session started in', () => {
    expect(defaultStartProject(LAST, () => false, NEW_CHAT)).toEqual(LAST)
  })

  test('is a new chat before any session has started', () => {
    expect(defaultStartProject(null, () => false, NEW_CHAT)).toEqual(NEW_CHAT)
  })

  test('is a new chat while the last project’s host is known to be down', () => {
    // A path names a folder on one machine only; a draft aimed at a host that
    // is down could not start, so a new chat on the default host stands in.
    expect(defaultStartProject(LAST, (serverId) => serverId === 'studio', NEW_CHAT)).toEqual(NEW_CHAT)
  })
})

// ─── ⌘N through the drafts controller ───

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

/** One pane, and the workspace members the drafts controller reads. */
function draftsInOnePane(modelOptionsByProvider: import('@solus/contracts/host-config').ModelOptionsByProvider = {}) {
  type Base = { name: string; params: { draftId: string } } | null
  const pane = { id: 'lead', base: null as Base }
  let drafts: InstanceType<typeof SessionDrafts>
  const workspace = {
    settings: { modelOptionsByProvider },
    activeTabId: '',
    defaultRunConfig: runIn(NEW_CHAT.directory),
    get focusedSourceId() {
      return pane.base?.name === 'draft' ? pane.base.params.draftId : null
    },
    runFor: (sourceId: string) => drafts.sessionDrafts.get(sourceId)?.run,
    rootTaskIdFor: () => null,
    opening: { moveToRunOnHost: () => {} },
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
  test('the next draft restores the saved options for its inherited model', () => {
    // WHY: draft creation runs inheritance twice; neither pass may reset the
    // options selected in the shared composer.
    const saved = { reasoningEffort: 'max' as const, contextWindow: 1_000_000, fastMode: false }
    const drafts = draftsInOnePane({ 'claude-code': { 'claude-opus-5': saved } })
    const source = drafts.openSessionDraft({}, '/code/solus')
    source.run.modelConfig.modelId = 'claude-opus-5'
    source.prompt.text = 'keep this draft'

    const next = drafts.openSessionDraft({ via: 'keybinding' })
    expect(next.run.modelConfig).toEqual({ modelId: 'claude-opus-5', ...saved })
  })

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
