import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { DispatchRepository, RunLocation, Session, SessionMeta } from '@solus/contracts/types'
import type { SessionPrepareRequest, SessionPrepareResult } from '@solus/contracts/rpc'
import { withSessionHostTurn, type SessionCloudHead, type SessionHostTurn } from '@solus/client-core/session-heads'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connectionCalls: string[] = []
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...singleHostServerConnections(),
    retain: (id: string) => connectionCalls.push(`retain:${id}`),
    unretain: (id: string) => connectionCalls.push(`unretain:${id}`),
    release: (id: string) => connectionCalls.push(`release:${id}`),
    ensure: (id: string) => connectionCalls.push(`ensure:${id}`),
    localServerId: () => 'local',
  },
}))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({ serversStore: {} }))
mock.module('@solus/workspace-ui/contexts/workspace/session-list.store.svelte', () => ({ sessionListStore: {} }))
const runes = globalThis as unknown as { $state?: unknown; $derived?: unknown }
const previousRunes = { $state: runes.$state, $derived: runes.$derived }
runes.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
runes.$derived = Object.assign(<T>(value: T) => value, { by: <T>(fn: () => T) => fn() })
afterAll(() => Object.assign(runes, previousRunes))

const { RunHostChanges } = await import('@solus/workspace-ui/contexts/workspace/run-host-changes')
const { isRunOnHostLocked } = await import('@solus/workspace-ui/components/servers/run-on')
const { folderLocation, openFolder, runHost, workingPlace } = await import('@solus/workspace-ui/contexts/workspace/run-location')

// A started session's run host changes between turns
// (docs/plans/portable-sessions.md §10). The pick moves the tab at once; the
// new host syncs in the background; the prompt carries the newest head.

const ON_A = folderLocation({ serverId: 'host-a', path: '/a/solus' })
const ON_B = openFolder(ON_A, { serverId: 'host-b', path: '/b/solus' })
const REPOSITORY: DispatchRepository = { cloneUrl: 'https://github.com/solus-sh/solus.git' }

function harness(opts: { turns?: SessionHostTurn[]; forked?: boolean; prepareResult?: SessionPrepareResult; cloud?: SessionCloudHead; runningServerId?: string; showsCloudCopy?: boolean } = {}) {
  let turns: readonly SessionHostTurn[] = opts.turns ?? [{ serverId: 'host-a', head: 'head-3', syncedTurn: 3 }]
  const session = {
    id: opts.forked ? 'fork-1' : 'session-1',
    agentSessionId: 'thread-1',
    forked: !!opts.forked,
    forkSourceSessionId: opts.forked ? 'session-1' : null,
    messages: [{ id: 'm1' }],
    status: 'idle',
    outboundPrompts: [],
    readOnlyReason: null,
    run: { location: ON_A },
  } as unknown as Session
  const prepared: Array<{ serverId: string; request: SessionPrepareRequest }> = []
  const watched: string[] = []
  const reads: string[] = []
  const metaByHost = new Map<string, SessionMeta>()
  const refreshed: string[] = []
  const pushRefusals: string[] = []
  const resumedInto: string[] = []
  const releasedCopies: string[] = []
  let showsCloudCopy = !!opts.showsCloudCopy
  const workspace = {
    tabOrder: ['tab-1'],
    sessionFor: () => session,
    ctxFor: () => ({}) as never,
    apiFor: () => ({
      unwatchSession: async () => {},
      watchSession: async () => { watched.push(runHost(session.run)); return {} },
    }) as never,
    refreshStartTarget: () => {},
    tabIdForSession: () => 'tab-1',
    opening: {
      resumeSession: async (meta: SessionMeta, resume: { intoTabId: string }) => { resumedInto.push(`${meta.serverId}:${resume.intoTabId}:${session.messages.length}`); return resume.intoTabId },
    },
    cloudTranscripts: {
      shows: () => showsCloudCopy,
      release: (sessionId: string) => { releasedCopies.push(sessionId); showsCloudCopy = false },
    },
  }
  const changes = new RunHostChanges(workspace, (tabId) => { refreshed.push(tabId) }, {
    resolveId: (serverId) => serverId,
    hostTurnsFor: () => turns,
    readMeta: async (serverId, sessionId) => {
      reads.push(`${serverId}:${sessionId}`)
      const meta = metaByHost.get(serverId) ?? null
      if (meta?.syncedTurn !== undefined) turns = withSessionHostTurn(turns, { serverId, head: meta.head ?? null, syncedTurn: meta.syncedTurn })
      return meta
    },
    prepare: async (serverId, request) => {
      prepared.push({ serverId, request })
      return opts.prepareResult ?? { state: 'started' }
    },
    cloudHeadFor: () => opts.cloud ?? null,
    runningServerFor: () => opts.runningServerId ?? null,
    cloudRepositoryKeyOf: () => null,
    notePushRefused: (serverId, sessionId, isRefused) => { pushRefusals.push(`${serverId}:${sessionId}:${isRefused}`) },
    hostRef: (serverId) => `installation-of-${serverId}`,
    repoKeyOf: () => 'github.com/solus-sh/solus',
    repository: async () => ({ ...REPOSITORY }),
  })
  return { changes, session, prepared, watched, reads, metaByHost, refreshed, pushRefusals, resumedInto, releasedCopies, setTurns: (next: SessionHostTurn[]) => { turns = next } }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  connectionCalls.length = 0
})

describe('Run on for a started session', () => {
  test('is open between turns and locked while a turn runs', () => {
    // WHY: no host owns a session (§4 decision 3), but one turn runs at a time
    // and its prompts go to the host that runs it (§4 decision 5).
    const idle = { status: 'idle', outboundPrompts: [], readOnlyReason: null } as unknown as Session
    expect(isRunOnHostLocked(idle)).toBe(false)
    expect(isRunOnHostLocked({ ...idle, status: 'completed' })).toBe(false)
    expect(isRunOnHostLocked({ ...idle, status: 'running' })).toBe(true)
    expect(isRunOnHostLocked({ ...idle, status: 'connecting' })).toBe(true)
    expect(isRunOnHostLocked({ ...idle, status: 'background' })).toBe(true)
    // A prompt that still waits for its host goes to that host.
    expect(isRunOnHostLocked({ ...idle, outboundPrompts: [{ clientPromptId: 'p' }] } as unknown as Session)).toBe(true)
    expect(isRunOnHostLocked(undefined)).toBe(true)
  })

  test('a pick moves the tab at once and prepares the new host with the newest head, its host, and the repository', async () => {
    // WHY: the pick must not wait for the network (flow first). The new host
    // gets what it needs to sync without a checkout of its own.
    const { changes, session, prepared, watched, reads } = harness()
    expect(changes.change('tab-1', ON_B)).toBe(true)
    // Synchronous: the tab is on the new host before any reply.
    expect(runHost(session.run)).toBe('host-b')
    expect(connectionCalls).toContain('retain:host-b')
    await settle()
    // The new host hears this session's sync card and next turn.
    expect(watched).toEqual(['host-b'])
    // The newest host is read once, for a head newer than the client saw.
    expect(reads).toEqual(['host-a:session-1'])
    expect(prepared).toEqual([{
      serverId: 'host-b',
      request: { sessionId: 'session-1', knownHead: 'head-3', sourceHostId: 'installation-of-host-a', repository: REPOSITORY },
    }])
  })

  test('a host that is current already is adopted where it keeps the session', async () => {
    // WHY: a host that ran the session before has its own worktree there; the
    // next turn must run in it, not in the project folder the pick named.
    const { changes, session, metaByHost, refreshed } = harness({ prepareResult: { state: 'current', head: 'head-3' } })
    metaByHost.set('host-b', { sessionId: 'session-1', cwd: '/b/solus/.worktrees/s1', head: 'head-3', syncedTurn: 3 } as SessionMeta)
    changes.change('tab-1', ON_B)
    await settle()
    expect(workingPlace(session.run)).toEqual({ serverId: 'host-b', path: '/b/solus/.worktrees/s1' })
    expect(refreshed).toEqual(['tab-1'])
  })

  test('the sync card that ends done adopts the new host', async () => {
    const { changes, session, metaByHost } = harness()
    metaByHost.set('host-b', { sessionId: 'session-1', cwd: '/b/restored', head: 'head-3', syncedTurn: 3 } as SessionMeta)
    changes.change('tab-1', ON_B)
    await settle()
    changes.syncCardChanged('host-b', 'session-1', { id: 'session-sync-session-1', title: '', status: 'done', steps: [] })
    await settle()
    expect(workingPlace(session.run).path).toBe('/b/restored')
  })
})

describe('what a prompt carries', () => {
  test('the newest head and the host that has it, when the run host is behind', () => {
    // WHY: §7.1. The host compares the head with its own and syncs first; the
    // client makes no request on the send path for it.
    const { changes, session } = harness()
    session.run.location = ON_B
    expect(changes.promptFields(session)).toEqual({ knownHead: 'head-3', sourceHostId: 'installation-of-host-a' })
  })

  test('nothing when the run host has the newest turn', () => {
    const { changes, session } = harness()
    expect(changes.promptFields(session)).toEqual({})
  })
})

describe('a restored tab', () => {
  test('keeps the host that has the conversation until the new host is current, then the new host', async () => {
    // WHY: a reload before the sync would restore a tab on a host with no copy
    // of its conversation, and show it empty.
    const { changes, session } = harness()
    changes.change('tab-1', ON_B)
    expect(changes.persistedLocation(session)).toBe(ON_A)
    changes.confirm(session.id)
    expect(changes.persistedLocation(session)).toBe(session.run.location)
    expect(runHost({ location: changes.persistedLocation(session) as RunLocation })).toBe('host-b')
  })

  test('a pick back to the host it came from needs no confirmation', () => {
    const { changes, session } = harness()
    changes.change('tab-1', ON_B)
    changes.change('tab-1', openFolder(ON_B, { serverId: 'host-a', path: '/a/solus' }))
    expect(runHost({ location: changes.persistedLocation(session) })).toBe('host-a')
  })
})

describe('a fork on another host', () => {
  test('prepares the source session there and sends its first prompt with the source facts', async () => {
    // WHY: decision 14. The fork is made from the source thread, so the new
    // host syncs the source session first; a fork on the source host is as today.
    const { changes, session, prepared, watched } = harness({ forked: true })
    expect(changes.promptFields(session)).toEqual({})
    changes.change('tab-1', ON_B)
    await settle()
    // The fork has no session on the new host until its first prompt.
    expect(watched).toEqual([])
    expect(prepared[0]?.request.sessionId).toBe('session-1')
    expect(changes.promptFields(session)).toEqual({
      knownHead: 'head-3',
      sourceHostId: 'installation-of-host-a',
      forkSourceSessionId: 'session-1',
    })
    // A pending fork keeps its pick across a reload: it has no conversation anywhere yet.
    expect(changes.persistedLocation(session)).toBe(session.run.location)
  })
})

describe('opening a session', () => {
  test('prepares a run host that is behind, and asks nothing of one that is current', async () => {
    // WHY: §10. A host that ran the session before is ready when the person sends.
    const current = harness()
    current.changes.opened('tab-1')
    await settle()
    expect(current.prepared).toEqual([])

    const behind = harness({ turns: [{ serverId: 'host-a', head: 'head-3', syncedTurn: 3 }, { serverId: 'host-b', head: 'head-2', syncedTurn: 2 }] })
    behind.session.run.location = ON_B
    behind.changes.opened('tab-1')
    await settle()
    expect(behind.prepared.map((entry) => entry.serverId)).toEqual(['host-b'])
  })
})

// With the cloud (docs/plans/portable-sessions-cloud.md §5.4, §8.1 E).
const CLOUD_HEAD = 'c'.repeat(40)
const CLOUD: SessionCloudHead = { head: CLOUD_HEAD, syncedTurn: 5, lastRunHostId: 'account-studio', runningHostId: null, lastRunServerId: null }

describe('the cloud as the source', () => {
  test('a prompt names the cloud head and the host that ran the last turn, though this client cannot reach it', () => {
    // WHY: the host that ran the last turn may be offline; the run host fetches from the cloud first.
    const { changes, session } = harness({ cloud: CLOUD })
    expect(changes.promptFields(session)).toEqual({ knownHead: CLOUD_HEAD, sourceHostId: 'account-studio' })
  })

  test('opening a session that the cloud has newer prepares the run host from the cloud', async () => {
    // WHY: the host is ready before the person sends, with no host-to-host read.
    const { changes, prepared, reads } = harness({ cloud: CLOUD })
    changes.opened('tab-1')
    await settle()
    expect(prepared).toEqual([{ serverId: 'host-a', request: { sessionId: 'session-1', knownHead: CLOUD_HEAD, sourceHostId: 'account-studio', repository: REPOSITORY } }])
    expect(reads).toEqual([])
  })

  test('a current host loads the conversation into a tab that opened from the cloud with none', async () => {
    // WHY: a cloud-only session shows its conversation once a machine that has it is selected.
    const { changes, session, metaByHost, resumedInto } = harness({ prepareResult: { state: 'current', head: CLOUD_HEAD } as SessionPrepareResult, cloud: CLOUD })
    session.messages = []
    metaByHost.set('host-b', { sessionId: 'session-1', serverId: 'host-b', cwd: '/b/solus', head: CLOUD_HEAD, syncedTurn: 5 } as SessionMeta)
    changes.change('tab-1', ON_B)
    await settle()
    expect(resumedInto).toEqual(['host-b:tab-1:0'])
  })

  test('a prompt while another connected host runs a turn moves the tab there first', () => {
    // WHY: one turn at a time (plan §4 decision 5): the prompt joins the running turn's queue.
    const { changes, session } = harness({ runningServerId: 'host-b' })
    changes.followRunningHost('tab-1')
    expect(runHost(session.run)).toBe('host-b')
    const stays = harness({ runningServerId: 'host-a' })
    stays.changes.followRunningHost('tab-1')
    expect(runHost(stays.session.run)).toBe('host-a')
  })

  test('"Use the newer copy" prepares the cloud head, reads the conversation again, and clears the refusal', async () => {
    // WHY: design answer 3.4. The run host becomes current and shows the session's one history.
    const { changes, prepared, metaByHost, resumedInto, pushRefusals } = harness({ prepareResult: { state: 'current', head: CLOUD_HEAD } as SessionPrepareResult, cloud: CLOUD })
    metaByHost.set('host-a', { sessionId: 'session-1', serverId: 'host-a', cwd: '/a/solus', head: CLOUD_HEAD, syncedTurn: 5 } as SessionMeta)
    await changes.useNewerCopy('tab-1')
    await settle()
    expect(prepared[0]?.request).toMatchObject({ sessionId: 'session-1', knownHead: CLOUD_HEAD, sourceHostId: 'account-studio' })
    expect(resumedInto).toEqual(['host-a:tab-1:0'])
    expect(pushRefusals).toEqual(['host-a:session-1:false'])
  })
})

// Read-only open (portable-sessions-cloud, Phase 5B): the tab shows the cloud copy.
describe('a tab that shows the cloud copy', () => {
  test('a current run host replaces the copy with its own conversation', async () => {
    // WHY: when a host that holds the session is ready, the live session takes
    // the copy's place in the same tab, with no reload and no second history.
    const { changes, metaByHost, resumedInto, releasedCopies } = harness({ prepareResult: { state: 'current', head: CLOUD_HEAD } as SessionPrepareResult, cloud: CLOUD, showsCloudCopy: true })
    metaByHost.set('host-b', { sessionId: 'session-1', serverId: 'host-b', cwd: '/b/solus', head: CLOUD_HEAD, syncedTurn: 5 } as SessionMeta)
    changes.change('tab-1', ON_B)
    await settle()
    expect(releasedCopies).toEqual(['session-1'])
    // The copy's rows went before the host's conversation loaded.
    expect(resumedInto).toEqual(['host-b:tab-1:0'])
  })

  test('a host that comes back prepares a tab that shows the copy', async () => {
    // WHY: the copy is not the host's conversation; a returning host must load its own.
    const shows = harness({ cloud: CLOUD, showsCloudCopy: true })
    shows.changes.hostReady('host-a')
    await settle()
    expect(shows.prepared.map((entry) => entry.serverId)).toEqual(['host-a'])
    const loaded = harness({ cloud: CLOUD })
    loaded.changes.hostReady('host-a')
    await settle()
    expect(loaded.prepared).toEqual([])
  })

  test('"Show it" loads the run host conversation in place of the copy', async () => {
    const { changes, metaByHost, resumedInto, releasedCopies } = harness({ showsCloudCopy: true })
    metaByHost.set('host-a', { sessionId: 'session-1', serverId: 'host-a', cwd: '/a/solus', head: 'head-3', syncedTurn: 3 } as SessionMeta)
    changes.showRunHostConversation('tab-1')
    await settle()
    expect(releasedCopies).toEqual(['session-1'])
    expect(resumedInto).toEqual(['host-a:tab-1:0'])
  })
})
