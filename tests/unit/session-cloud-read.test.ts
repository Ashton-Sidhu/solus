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
import type { SessionCloudHead } from '@solus/client-core/session-heads'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { SolusApiClient } from '@solus/contracts/solus-api/client'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { SolusApiRequest } from '@solus/contracts/solus-api/request'

// Read-only open with no host online (docs/plans/portable-sessions-cloud.md,
// Phase 5B). Desktop, web, and mobile share these rules.

const HEAD = 'a'.repeat(40)
const CLOUD: SessionCloudHead = { head: HEAD, syncedTurn: 3, lastRunHostId: 'account-studio', runningHostId: null, lastRunServerId: 'studio' }
const base: SessionCloudReadSourceInput = {
  hasStarted: true, hasHostRows: false, isSignedIn: true, isCloudListed: true,
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

  test('an online run host is never replaced when the cloud has no turns of the session', () => {
    // WHY: a session that never synced, or an older host, must load from its host as before.
    expect(sessionCloudReadSource({ ...base, cloud: null })).toBeNull()
    expect(sessionCloudReadSource({ ...base, cloud: { ...CLOUD, head: null, syncedTurn: 0 } })).toBeNull()
  })

  test('an offline run host names why there is no copy to read', () => {
    // WHY: each reason has a different fix: sign in, turn on sync, or wait for the first turn commit.
    const away = { ...base, isRunHostAway: true, runServerId: 'studio' }
    expect(sessionCloudReadSource(away)).toBe('cloud')
    expect(sessionCloudReadSource({ ...away, isSignedIn: false, cloud: null })).toBe('not-signed-in')
    expect(sessionCloudReadSource({ ...away, cloud: null })).toBe('sync-off')
    // WHY: an absent cloud record does not prove that cloud sync is off on the run host.
    expect(sessionCloudReadSource({ ...away, cloud: null, isCloudSyncOn: null })).toBe('not-in-cloud')
    expect(sessionCloudReadSource({ ...away, cloud: null, isCloudListed: false })).toBe('listing')
    expect(sessionCloudReadSource({ ...away, cloud: { ...CLOUD, head: null, syncedTurn: 0 } })).toBe('empty')
  })
})

describe('the state a read-only conversation shows', () => {
  const ready = { status: 'ready' as const, error: null, readHead: HEAD, unavailableTurnCount: 0 }
  const input = { source: 'cloud' as const, read: ready, messageCount: 4, isTurnLive: false, cloud: CLOUD }

  test('loading, ready, and error each show while the copy reads', () => {
    // WHY: a spinner that never ends, or rows without the read-only note, would lie.
    expect(sessionCloudReadView({ ...input, read: null })).toEqual({ kind: 'loading' })
    expect(sessionCloudReadView({ ...input, source: 'listing', read: null })).toEqual({ kind: 'loading' })
    expect(sessionCloudReadView({ ...input, read: { ...ready, status: 'loading' } })).toEqual({ kind: 'loading' })
    expect(sessionCloudReadView(input)).toEqual({ kind: 'ready', unavailableTurnCount: 0 })
    expect(sessionCloudReadView({ ...input, read: { ...ready, status: 'error' } })).toMatchObject({ kind: 'error' })
  })

  test('a copy with no rows is empty, and says whether the turns have rows at all', () => {
    // WHY: "no turns yet" and "turns without saved rows" need different words.
    expect(sessionCloudReadView({ ...input, messageCount: 0 })).toEqual({ kind: 'empty', reason: 'no-turns' })
    expect(sessionCloudReadView({ ...input, messageCount: 0, read: { ...ready, unavailableTurnCount: 2 } })).toEqual({ kind: 'empty', reason: 'no-rows' })
    expect(sessionCloudReadView({ ...input, source: 'empty', read: null })).toEqual({ kind: 'empty', reason: 'no-turns' })
  })

  test('a newer cloud head makes the copy stale, unless the newer turn runs on screen', () => {
    // WHY: session.headChanged means turns this copy does not show; a live turn
    // in this tab is the reason for the new head, so it is not stale.
    const newer = { ...CLOUD, head: 'b'.repeat(40), syncedTurn: 4 }
    expect(sessionCloudReadView({ ...input, cloud: newer })).toEqual({ kind: 'stale', reason: 'head-changed' })
    expect(sessionCloudReadView({ ...input, cloud: newer, isTurnLive: true })).toEqual({ kind: 'ready', unavailableTurnCount: 0 })
  })

  test('a host that holds the session coming online makes the copy stale, then nothing shows', () => {
    // WHY: the live session takes the copy's place; while it loads, the copy must not claim to be current.
    expect(sessionCloudReadView({ ...input, source: null })).toEqual({ kind: 'stale', reason: 'host-online' })
    expect(sessionCloudReadView({ ...input, source: null, isTurnLive: true })).toBeNull()
    expect(sessionCloudReadView({ ...input, source: null, read: null })).toBeNull()
  })

  test('signed out and sync off show whatever the copy was', () => {
    expect(sessionCloudReadView({ ...input, source: 'not-signed-in', read: null })).toEqual({ kind: 'not-signed-in' })
    expect(sessionCloudReadView({ ...input, source: 'sync-off', read: null })).toEqual({ kind: 'sync-off' })
  })
})

describe('the words of each state', () => {
  test('the ready copy says tool output is not in it, and names turns without rows', () => {
    // WHY: archived rows have no tool result bodies (D8); that is a plain fact, not an error.
    expect(sessionCloudReadText({ kind: 'ready', unavailableTurnCount: 0 }, 'Studio').detail).toBe('Tool output is not available in Solus Cloud.')
    expect(sessionCloudReadText({ kind: 'ready', unavailableTurnCount: 2 }, 'Studio').detail).toContain('2 older turns are not in it')
  })

  test('each state that needs a person offers its one action', () => {
    expect(sessionCloudReadText({ kind: 'stale', reason: 'head-changed' }, 'Studio').action).toBe('show-newer')
    expect(sessionCloudReadText({ kind: 'stale', reason: 'host-online' }, 'Studio')).toMatchObject({ message: 'Studio has this session now.', action: 'show-live' })
    expect(sessionCloudReadText({ kind: 'error', message: 'x' }, 'Studio').action).toBe('retry')
    expect(sessionCloudReadText({ kind: 'not-signed-in' }, 'Studio')).toMatchObject({ message: 'Studio is offline.', action: null })
    expect(sessionCloudReadText({ kind: 'not-in-cloud' }, 'Studio').detail).toContain('Choose a machine')
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
  test('a page asks for one turn and names when its turn started', async () => {
    // WHY: the diff of a turn joins the transcript turn by its start time.
    const asked: SessionHistoryPageRequest[] = []
    const page = await readSessionCloudPage({
      loadSessionPage: async (request) => {
        asked.push(request)
        return { messages: [{ role: 'system', content: '', timestamp: 5 }, { role: 'user', content: 'go', timestamp: 7 }], before: null, turnIndex: 2 }
      },
    }, { sessionId: 's-1', provider: 'codex', before: 'cursor' })
    expect(asked).toEqual([{ sessionId: 's-1', provider: 'codex', before: 'cursor', turnLimit: 1, deferArtifactHtml: true }])
    expect(page.turnStartedAt).toBe(7)
    expect(page.turnIndex).toBe(2)
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
