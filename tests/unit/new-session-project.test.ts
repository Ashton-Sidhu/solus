import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { defaultStartProject, resolveNewRunConfig, startProjectOf } from '@solus/workspace-ui/contexts/workspace/run-config'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { checkoutPlace, codebaseOf, folderLocation, refusesCodebase, usedCodebase } from '@solus/workspace-ui/contexts/workspace/run-location'

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

describe('what the active session leaves for a new session with nothing to inherit from', () => {
  // WHY: boot, and closing the last tab, open a draft with no session on screen.
  // The rule: a session that used a codebase gives the next one the codebase;
  // a session that used a project gives it the project. ⌘N follows the same rule.
  test('is its codebase when it used one', () => {
    const run = runIn('/code/solus')
    run.location = folderLocation({ serverId: 'studio', path: '/code/solus' }, { codebaseId: 'cb-1' })
    const left = startProjectOf(run)
    expect(left).toEqual({ serverId: 'studio', directory: '/code/solus', codebaseId: 'cb-1' })
    // The next draft starts with the same codebase.
    const project = defaultStartProject(left, () => false, NEW_CHAT)
    expect(codebaseOf({ location: folderLocation({ serverId: project.serverId, path: project.directory }, { codebaseId: project.codebaseId }) })).toBe('cb-1')
  })

  test('is its project with no codebase when it used a project', () => {
    // A folder that one codebase holds gets that codebase when nothing says
    // "No codebase", so the project alone would not stay a project.
    expect(startProjectOf(runIn('/code/solus'))).toEqual({ serverId: 'local', directory: '/code/solus', noCodebase: true })
  })

  test('keeps the refusal of a codebase, so the next session also uses the project', () => {
    const run = runIn('/code/solus')
    run.location = folderLocation({ serverId: 'local', path: '/code/solus' }, { noCodebase: true })
    const left = startProjectOf(run)
    expect(left).toEqual({ serverId: 'local', directory: '/code/solus', noCodebase: true })
    const next = folderLocation({ serverId: 'local', path: left!.directory }, { codebaseId: left!.codebaseId, noCodebase: left!.noCodebase })
    expect(refusesCodebase({ location: next })).toBe(true)
  })

  test('is nothing for a chat', () => {
    expect(startProjectOf(runIn(NEW_CHAT_DIRECTORY))).toBeNull()
  })
})

describe('a new session from a session', () => {
  // WHY: the screen recording. The active session used the solus project, and
  // the new draft showed the codebase that holds the solus folder.
  const defaults = runIn(NEW_CHAT_DIRECTORY)

  test('from a session that used a project uses the project, with no codebase', () => {
    const session = runIn('/code/solus')
    const next = resolveNewRunConfig(defaults, { ...session, location: usedCodebase(session.location) }, { freshTask: true })
    expect(checkoutPlace(next).path).toBe('/code/solus')
    expect(codebaseOf(next)).toBeNull()
    expect(refusesCodebase(next)).toBe(true)
  })

  test('from a session that used a codebase uses the codebase', () => {
    const session = runIn('/code/solus')
    session.location = folderLocation({ serverId: 'local', path: '/code/solus' }, { codebaseId: 'cb-1' })
    const next = resolveNewRunConfig(defaults, { ...session, location: usedCodebase(session.location) }, { freshTask: true })
    expect(codebaseOf(next)).toBe('cb-1')
    expect(refusesCodebase(next)).toBe(false)
  })

  test('from a chat is a new chat, with no codebase choice', () => {
    expect(usedCodebase(runIn(NEW_CHAT_DIRECTORY).location).noCodebase).toBeUndefined()
  })
})

// ─── ⌘N through the drafts controller ───

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
    { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value },
  )
  ;({ SessionDrafts } = await import('@solus/workspace-ui/contexts/workspace/session-drafts.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function runIn(workingDirectory: string): RunConfig {
  return {
    location: folderLocation({ serverId: 'local', path: workingDirectory }),
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'full-access',
    provider: 'claude-code',
    sessionSkills: [],
  }
}

/** One pane, and the workspace members the drafts controller reads. */
function draftsInOnePane(modelOptionsByProvider: import('@solus/contracts/host-config').ModelOptionsByProvider = {}) {
  type Surface = { name: string; params: { draftId: string } }
  const pane = { id: 'lead', surfaces: [] as Surface[], activeSurfaceIndex: 0 }
  let drafts: InstanceType<typeof SessionDrafts>
  const workspace = {
    settings: { modelOptionsByProvider, hostBalancing: { enabled: false, preferences: {} } },
    activeTabId: '',
    defaultRunConfig: runIn(NEW_CHAT.directory),
    get focusedSourceId() {
      const shown = pane.surfaces[0]
      return shown?.name === 'draft' ? shown.params.draftId : null
    },
    runFor: (sourceId: string) => drafts.sessionDrafts.get(sourceId)?.run,
    inheritedRunFor: (sourceId: string) => drafts.sessionDrafts.get(sourceId)?.run,
    rootTaskIdFor: () => null,
    opening: { moveToRunOnHost: () => {} },
    refreshStartTarget: async () => {},
    router: {
      focusedPaneId: pane.id,
      panes: [pane],
      leadingPane: pane,
      storedSurfaces: [],
      pane: () => pane,
      navigate: (ref: Surface) => { pane.surfaces = [ref] },
      dropStrip: () => {},
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

    expect(checkoutPlace(next.run).path).toBe('/code/solus')
    // The empty draft it replaced is still let go of: nothing lists it.
    expect(drafts.sessionDrafts.has(empty.id)).toBe(false)
  })

  test('from a written-in draft keeps its project and keeps the draft', () => {
    const drafts = draftsInOnePane()
    const written = drafts.openSessionDraft({}, '/code/solus')
    written.prompt.text = 'half a thought'

    const next = drafts.openSessionDraft({ freshTask: true, via: 'keybinding' })

    expect(checkoutPlace(next.run).path).toBe('/code/solus')
    expect(drafts.sessionDrafts.has(written.id)).toBe(true)
  })
})
