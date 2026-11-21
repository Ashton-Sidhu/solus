import { describe, expect, test } from 'bun:test'
import {
  readSessionCloudPage,
  readSessionTurnDiff,
  sessionCloudReadSource,
  sessionCloudReadView,
  type SessionCloudReadSourceInput,
} from '@solus/client-core/session-cloud-read'
import { sessionCloudReadText, sessionTurnDiffText } from '@solus/client-core/session-cloud-read-text'
import { workspaceRecordMethods } from '@solus/client-core/workspace-records'
import { HostRpcError } from '@solus/client-core/rpc-error'
import type { SessionCloudHead } from '@solus/client-core/session-heads'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { SolusApiClient } from '@solus/contracts/solus-api/client'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { SolusApiRequest } from '@solus/contracts/solus-api/request'

// Read-only open with no host online (docs/plans/portable-sessions-cloud.md,
// "The mirror for readers"). Desktop, web, and mobile share these rules.

const HEAD = 'a'.repeat(40)
const CLOUD: SessionCloudHead = { head: HEAD, syncedTurn: 3, lastRunHostId: 'account-studio', runningHostId: null, lastRunServerId: 'studio' }
const base: SessionCloudReadSourceInput = {
  hasStarted: true, hasHostRows: false, isSignedIn: true,
  runServerId: 'laptop', isRunHostAway: false, runTurn: undefined, cloud: CLOUD,
}

describe('where the conversation comes from', () => {
  test('an online run host with no copy reads the cloud; one that has the session shows its own', () => {
    // WHY: a session opened from the cloud list on a machine that does not have it
    // must still show its history, but a host that holds the session is the authority.
    expect(sessionCloudReadSource(base)).toBe('cloud')
    expect(sessionCloudReadSource({ ...base, runTurn: { serverId: 'laptop', head: HEAD, syncedTurn: 3 } })).toBeNull()
    expect(sessionCloudReadSource({ ...base, runServerId: 'studio' })).toBeNull()
    expect(sessionCloudReadSource({ ...base, hasHostRows: true })).toBeNull()
    expect(sessionCloudReadSource({ ...base, hasStarted: false })).toBeNull()
  })

  test('an online run host is never replaced when no other host ran the session', () => {
    // WHY: a session that never synced, or an older host, must load from its host as before.
    expect(sessionCloudReadSource({ ...base, cloud: null })).toBeNull()
    expect(sessionCloudReadSource({ ...base, cloud: { ...CLOUD, head: null, syncedTurn: 0 } })).toBeNull()
  })

  test('with no host to read, a signed-in client asks the mirror, whatever the session repository says', () => {
    // WHY: the mirror is the one store for a reader. An organization session with cloud
    // sync off has no session repository, but its rows are in the mirror; a client that
    // waited for repository facts said "no copy" for a session it could read.
    const away = { ...base, isRunHostAway: true, runServerId: 'studio' }
    expect(sessionCloudReadSource(away)).toBe('cloud')
    expect(sessionCloudReadSource({ ...away, cloud: null })).toBe('cloud')
    expect(sessionCloudReadSource({ ...away, cloud: { ...CLOUD, head: null, syncedTurn: 0 } })).toBe('cloud')
    expect(sessionCloudReadSource({ ...base, isHostReadUnavailable: true, cloud: null })).toBe('cloud')
    expect(sessionCloudReadSource({ ...away, isSignedIn: false, cloud: null })).toBe('not-signed-in')
  })
})

describe('the state a read-only conversation shows', () => {
  const ready = { status: 'ready' as const, error: null, hasNewerRows: false }
  const input = { source: 'cloud' as const, read: ready, messageCount: 4, isTurnLive: false }

  test('loading, ready, and error each show while the copy reads', () => {
    // WHY: a spinner that never ends, or rows without the read-only note, would lie.
    expect(sessionCloudReadView({ ...input, read: null })).toEqual({ kind: 'loading' })
    expect(sessionCloudReadView({ ...input, read: { ...ready, status: 'loading' } })).toEqual({ kind: 'loading' })
    expect(sessionCloudReadView(input)).toEqual({ kind: 'ready' })
    expect(sessionCloudReadView({ ...input, read: { ...ready, status: 'error' } })).toMatchObject({ kind: 'error' })
  })

  test('a read that answers no rows is "no copy", and names the sync switch only when it is known to be off', () => {
    // WHY: the mirror's answer decides, not a list of repositories. An absent copy does
    // not prove that cloud sync is off on the run host.
    expect(sessionCloudReadView({ ...input, messageCount: 0 })).toEqual({ kind: 'not-in-cloud' })
    expect(sessionCloudReadView({ ...input, messageCount: 0, isCloudSyncOn: null })).toEqual({ kind: 'not-in-cloud' })
    expect(sessionCloudReadView({ ...input, messageCount: 0, isCloudSyncOn: false })).toEqual({ kind: 'sync-off' })
  })

  test('rows that arrive in the mirror make the copy stale, unless the newer turn runs on screen', () => {
    // WHY: session.transcriptChanged means rows this copy does not show; a live turn
    // in this tab is the reason for the new rows, so it is not stale. A copy with no
    // rows offers the read too: the first rows of the session just arrived.
    const newer = { ...ready, hasNewerRows: true }
    expect(sessionCloudReadView({ ...input, read: newer })).toEqual({ kind: 'stale', reason: 'newer-rows' })
    expect(sessionCloudReadView({ ...input, read: newer, isTurnLive: true })).toEqual({ kind: 'ready' })
    expect(sessionCloudReadView({ ...input, read: newer, messageCount: 0 })).toEqual({ kind: 'stale', reason: 'newer-rows' })
  })

  test('a host that holds the session coming online makes the copy stale, then nothing shows', () => {
    // WHY: the live session takes the copy's place; while it loads, the copy must not claim to be current.
    expect(sessionCloudReadView({ ...input, source: null })).toEqual({ kind: 'stale', reason: 'host-online' })
    expect(sessionCloudReadView({ ...input, liveServerId: 'studio' })).toEqual({ kind: 'stale', reason: 'host-online' })
    expect(sessionCloudReadView({ ...input, source: null, isTurnLive: true })).toBeNull()
    expect(sessionCloudReadView({ ...input, source: null, read: null })).toBeNull()
  })

  test('signed out shows whatever the copy was', () => {
    expect(sessionCloudReadView({ ...input, source: 'not-signed-in', read: null })).toEqual({ kind: 'not-signed-in' })
  })
})

describe('the words of each state', () => {
  test('the ready copy says tool output is not in it', () => {
    // WHY: mirrored rows have no tool result bodies (D8); that is a plain fact, not an error.
    expect(sessionCloudReadText({ kind: 'ready' }, 'Studio').detail).toBe('Tool output is not available in Solus Cloud.')
  })

  test('each state that needs a person offers its one action', () => {
    expect(sessionCloudReadText({ kind: 'stale', reason: 'newer-rows' }, 'Studio').action).toBe('show-newer')
    expect(sessionCloudReadText({ kind: 'stale', reason: 'host-online' }, 'Studio')).toMatchObject({ message: 'Studio has this session now.', action: 'show-live' })
    expect(sessionCloudReadText({ kind: 'error', message: 'x' }, 'Studio').action).toBe('retry')
    expect(sessionCloudReadText({ kind: 'not-signed-in' }, 'Studio')).toMatchObject({ message: 'Studio is offline.', action: null })
    expect(sessionCloudReadText({ kind: 'not-in-cloud' }, 'Studio').detail).toContain('choose a machine')
  })

  test('a reader who cannot pick a machine gets words that name no Run on', () => {
    // WHY: a read-only tab has no Run on to pick; words that name it send the reader nowhere.
    for (const view of [{ kind: 'ready' }, { kind: 'not-in-cloud' }, { kind: 'sync-off' }] as const) {
      const text = sessionCloudReadText(view, 'Studio', false)
      expect(`${text.message} ${text.detail ?? ''}`).not.toContain('Run on')
    }
    expect(sessionCloudReadText({ kind: 'ready' }, 'Studio', false).message).toBe('Read only, from Solus Cloud.')
  })

  test('a turn diff that cannot be drawn says why', () => {
    // WHY: too-large and not-available are honest states, each with its own words.
    expect(sessionTurnDiffText({ status: 'too-large', filesChanged: 3, additions: 40, deletions: 2 })).toContain('3 files (+40 −2)')
    expect(sessionTurnDiffText({ status: 'not-available' })).toBe('Solus Cloud has no diff of this turn.')
    expect(sessionTurnDiffText({ status: 'no-change' })).toBe('This turn changed no files.')
    expect(sessionTurnDiffText({ status: 'available', patch: 'x' })).toBeNull()
  })
})

describe('reading from the Solus API', () => {
  test('a page asks for the first turns of a conversation and passes the turn diffs of its rows', async () => {
    // WHY: the mirror answers many turns for each page; a client joins each diff to its turn by time.
    const asked: SessionHistoryPageRequest[] = []
    const page = await readSessionCloudPage({
      loadSessionPage: async (request) => {
        asked.push(request)
        return { messages: [{ role: 'user', content: 'go', timestamp: 7 }], before: null, turnDiffs: [{ turnIndex: 2, endedAt: 9 }] }
      },
    }, { sessionId: 's-1', provider: 'codex', before: 'cursor' })
    expect(asked).toEqual([{ sessionId: 's-1', provider: 'codex', before: 'cursor', turnLimit: 10, deferArtifactHtml: true }])
    expect(page.turnDiffs).toEqual([{ turnIndex: 2, endedAt: 9 }])
  })

  test('a session that the Solus API refuses is a copy with no rows; any other failure is an error', async () => {
    // WHY: the API gives no role on a session that is not in the mirror for this person.
    // That is "no copy", with its own words; a Try again button would never help.
    const refused = await readSessionCloudPage({ loadSessionPage: async () => { throw new HostRpcError('This session is not shared with you', 'FORBIDDEN') } }, { sessionId: 's-1', provider: 'codex' })
    expect(refused).toEqual({ messages: [], before: null })
    await expect(readSessionCloudPage({ loadSessionPage: async () => { throw new Error('disconnected') } }, { sessionId: 's-1', provider: 'codex' })).rejects.toThrow('disconnected')
  })

  test('the turn diff request names both path parameters', async () => {
    // WHY: the route has two parameters; the client once filled only the first.
    const sent: SolusApiRequest[] = []
    const records = workspaceRecordMethods(new SolusApiClient({
      contextKey: () => 'key',
      send: async (request) => { sent.push(request); return { status: 200, etag: null, retryAfter: null, body: JSON.stringify({ status: 'not-available' }) } },
    }))
    expect(await records.sessionTurnDiff('s 1', 4)).toEqual({ status: 'not-available' })
    expect(sent[0]?.path).toBe('/sessions/s%201/turns/4/diff')
  })

  test('an older API with no diff route gives a typed absent diff', async () => {
    // WHY: old Solus API hosts answer 404 for this route; the phone must not show a retry error.
    expect(await readSessionTurnDiff({ sessionTurnDiff: async () => { throw new WorkspaceRequestError(404, 'NOT_FOUND', 'No route') } }, 's-1', 0))
      .toEqual({ status: 'not-available' })
  })
})
