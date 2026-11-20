import { describe, expect, test } from 'bun:test'
import {
  afterTurnSettled,
  newestSessionServer,
  sessionHostTurnOf,
  sessionSyncOrigin,
  type SessionCloudHead,
  type SessionHostTurn,
} from '@solus/client-core/session-heads'
import { conversationAwaitsMachine, sessionCloudState, sessionCloudStateText } from '@solus/client-core/session-cloud-state'

// The source rule and the states of a portable session when the cloud knows it
// (docs/plans/portable-sessions-cloud.md §5.4, §8.1 E). Desktop, web, and
// mobile decide with these rules, so a prompt, a row, and a card agree.

const HEAD_A = 'a'.repeat(40)
const HEAD_CLOUD = 'c'.repeat(40)
const turn = (serverId: string, syncedTurn: number, head: string | null = `${serverId}-${syncedTurn}`): SessionHostTurn => ({ serverId, head, syncedTurn })
const cloud = (fields: Partial<SessionCloudHead> = {}): SessionCloudHead => ({
  head: HEAD_CLOUD, syncedTurn: 4, lastRunHostId: 'account-host-b', runningHostId: null, lastRunServerId: null, ...fields,
})

describe('the newest head with the cloud', () => {
  test('the cloud is newer than every connected host: its head and its last run host are the source', () => {
    // WHY: the host that ran the last turn may be offline or unknown to this
    // client; the run host fetches from the cloud first (plan §4 decision 15
    // no longer needs that host to be online).
    const origin = sessionSyncOrigin([turn('host-a', 3, HEAD_A)], 'host-a', cloud())
    expect(origin).toEqual({ knownHead: HEAD_CLOUD, sourceServerId: null, sourceHostId: 'account-host-b' })
  })

  test('a connected host newer than the cloud stays the source, named by this client', () => {
    // WHY: a turn that is not pushed yet is only on that host.
    const origin = sessionSyncOrigin([turn('host-a', 5, HEAD_A), turn('host-b', 4)], 'host-b', cloud({ syncedTurn: 4 }))
    expect(origin).toEqual({ knownHead: HEAD_A, sourceServerId: 'host-a', sourceHostId: null })
  })

  test('a run host that has the cloud head, or ran the last turn, sends no head', () => {
    // WHY: a head on a current host would start a sync for nothing, and the
    // turn start must make no network request (plan §4 decision 7).
    expect(sessionSyncOrigin([turn('host-a', 3, HEAD_CLOUD)], 'host-a', cloud())).toBeNull()
    expect(sessionSyncOrigin([], 'host-b', cloud({ lastRunServerId: 'host-b' }))).toBeNull()
  })

  test('a tie goes to the hosts, and no cloud gives the rule of phase 4A', () => {
    // WHY: an equal count means the same history; a host read is the direct copy.
    expect(sessionSyncOrigin([turn('host-a', 4, HEAD_A)], 'host-a', cloud())).toBeNull()
    expect(sessionSyncOrigin([turn('host-a', 4, HEAD_A), turn('host-b', 2)], 'host-b', null)?.sourceServerId).toBe('host-a')
  })

  test('the row names the host of the last turn from the cloud when it is newer', () => {
    // WHY: "Last ran on <host>" must not name an older host that this client happens to reach.
    expect(newestSessionServer([turn('host-a', 3)], 'host-a', cloud({ lastRunServerId: 'host-b' }))).toBe('host-b')
    expect(newestSessionServer([turn('host-a', 5)], 'host-a', cloud({ lastRunServerId: 'host-b' }))).toBe('host-a')
  })

  test('a turn that ends on a host that synced from the cloud counts past the cloud', () => {
    // WHY: the host fetched the cloud head before its turn; counting from an
    // older host read would make another host look as new and send no head.
    const turns = afterTurnSettled([turn('host-a', 2)], 'host-a', 6)
    expect(turns[0]?.syncedTurn).toBe(7)
  })

  test('a refused push reads from the session info of the host', () => {
    // WHY: the host sets `pushRefused` when the cloud refused its push. A client that reads another
    // name never shows the message, and the person keeps sending prompts that the host refuses.
    expect(sessionHostTurnOf('host-a', { head: HEAD_A, syncedTurn: 3, pushRefused: true })?.pushRefused).toBe(true)
    expect(sessionHostTurnOf('host-a', { head: HEAD_A, syncedTurn: 3 })?.pushRefused).toBeUndefined()
  })
})

describe('the cloud state of a session on its run host', () => {
  const base = { runServerId: 'host-a', runningServerId: null }

  test('not synced yet: a host has a newer turn than the cloud', () => {
    // WHY: the person must know that another machine cannot continue from that turn yet.
    expect(sessionCloudState({ ...base, turns: [turn('host-a', 5)], cloud: cloud({ syncedTurn: 4 }) })).toEqual({ kind: 'not-synced' })
  })

  test('no state when the cloud has the newest turn, has no copy, or the client is signed out', () => {
    // WHY: a stale "Not synced yet" after the push, or one shown with sync off, is a lie.
    expect(sessionCloudState({ ...base, turns: [turn('host-a', 4)], cloud: cloud({ syncedTurn: 4 }) })).toBeNull()
    expect(sessionCloudState({ ...base, turns: [turn('host-a', 4)], cloud: cloud({ syncedTurn: 0, head: null }) })).toBeNull()
    expect(sessionCloudState({ ...base, turns: [turn('host-a', 4)], cloud: null })).toBeNull()
  })

  test('running elsewhere: another connected host runs a turn', () => {
    // WHY: one turn at a time (plan §4 decision 5); Run on locks and the prompt goes there.
    expect(sessionCloudState({ ...base, turns: [], cloud: cloud(), runningServerId: 'host-b' })).toEqual({ kind: 'running-elsewhere', runningServerId: 'host-b' })
    expect(sessionCloudState({ ...base, turns: [], cloud: cloud({ syncedTurn: 0, head: null }), runningServerId: 'host-a' })).toBeNull()
  })

  test('a refused push wins, from the host fact or from a refused prompt, and names where it continued', () => {
    // WHY: the second history must not grow; the person chooses Fork or the newer copy.
    const refused = sessionCloudState({ ...base, turns: [{ ...turn('host-a', 5), pushRefused: true }], cloud: cloud({ lastRunServerId: 'host-b' }), runningServerId: 'host-b' })
    expect(refused).toEqual({ kind: 'push-refused', continuedOnServerId: 'host-b', continuedOnHostId: 'account-host-b' })
    expect(sessionCloudState({ ...base, turns: [], cloud: null, wasPromptRefused: true })?.kind).toBe('push-refused')
    expect(sessionCloudStateText(refused!, (serverId) => serverId === 'host-b' ? 'Studio' : 'another machine'))
      .toBe('This session continued on Studio. The turns on this machine are not in it.')
  })
})

describe('a conversation that no machine shows yet', () => {
  const input = {
    hasStarted: true, messageCount: 0, isLoadingHistory: false, hasStatusCard: false,
    runServerId: 'host-a', isRunHostAway: false, runTurn: undefined, cloud: cloud(),
  }

  test('a cloud-only session on a host that does not have it waits calmly', () => {
    // WHY: with no host online the transcript is a later phase; an endless spinner or an error would lie.
    expect(conversationAwaitsMachine(input)).toBe(true)
    // The offline host that ran the last turn has it, but cannot show it now.
    expect(conversationAwaitsMachine({ ...input, cloud: cloud({ lastRunServerId: 'host-a' }), isRunHostAway: true })).toBe(true)
  })

  test('a host that has it, a load, a sync card, or messages show the conversation instead', () => {
    // WHY: the empty state must never hide a conversation that can load.
    expect(conversationAwaitsMachine({ ...input, cloud: cloud({ lastRunServerId: 'host-a' }) })).toBe(false)
    expect(conversationAwaitsMachine({ ...input, runTurn: turn('host-a', 2) })).toBe(false)
    expect(conversationAwaitsMachine({ ...input, isLoadingHistory: true })).toBe(false)
    expect(conversationAwaitsMachine({ ...input, hasStatusCard: true })).toBe(false)
    expect(conversationAwaitsMachine({ ...input, messageCount: 1 })).toBe(false)
    expect(conversationAwaitsMachine({ ...input, cloud: null })).toBe(false)
  })
})
