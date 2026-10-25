import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from './helpers/test-db'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE } from '@solus/contracts/session-state'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * organize_session moves a session in the person's list the way the sidebar
 * does, and every move it makes reaches clients through the host's events.
 */

let tool: typeof import('@solus/server/execution/agents/tools/session-organize-tool')
let states: typeof import('@solus/server/data/sessions/session-states')
let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let records: typeof import('@solus/server/data/sessions/session-records')
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']
let personKey = ''
let closeDb: typeof import('@solus/server/db')['closeDb']
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
const NOW = Date.parse('2026-10-11T12:00:00Z')
const OWNER = { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Mac' }

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-organize-tool-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tool = await import('@solus/server/execution/agents/tools/session-organize-tool')
  states = await import('@solus/server/data/sessions/session-states')
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  records = await import('@solus/server/data/sessions/session-records')
  ;({ withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority'))
  personKey = (await import('@solus/server/host/host-user')).hostUserKey()
  ;({ closeDb } = await import('@solus/server/db'))
  // The tool organizes a session at its home, through the same operations as the API.
  const { createWorkspaceOperations } = await import('@solus/server/data/workspace/service')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { installWorkspaceToolOperations } = await import('@solus/server/data/workspace/tool-context')
  installWorkspaceToolOperations(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), 'this-mac')
  // Only "other-session" exists besides the caller.
  sessionTools.setSessionController({
    getSessionInfo: async (sessionId: string) => sessionId === 'other-session' ? { sessionId } : null,
  } as never)
})

beforeEach(async () => {
  for (const sessionId of ['caller', 'other-session']) {
    await records.upsertSessionRecord('local', { sessionId, provider: 'codex', projectPath: '-repo', lastActivityAt: NOW })
  }
})

afterEach(async () => {
  await resetTestDatabase()
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** The tool runs inside an agent's turn, for the person the turn is for. */
function organize(input: Parameters<typeof tool.organizeSession>[0]) {
  return withWorkspaceToolAuthority(OWNER, () => tool.organizeSession(input, 'caller', NOW))
}

function stateOf(sessionId: string) {
  return new states.SessionShelf(sessionId).state()
}

function viewOf(sessionId: string) {
  return new states.SessionViewer(sessionId, personKey).view()
}

describe('organize_session', () => {
  test('settles the calling session by default for everyone, and unsettle reverses it', async () => {
    expect(await organize({ action: 'settle' })).toMatchObject({ ok: true, text: 'This session is settled.' })
    expect(await stateOf('caller')).toMatchObject({ settledBy: 'person' })
    expect(await organize({ action: 'settle' })).toMatchObject({ text: 'This session was settled already.' })

    expect(await organize({ action: 'unsettle' })).toMatchObject({ ok: true })
    expect(await stateOf('caller')).toEqual(UNSETTLED_SESSION_STATE)
  })

  test("snoozes another session in the person's own list, with a note, and unsnooze wakes it", async () => {
    const until = '2026-10-12T09:00:00Z'
    const snoozed = await organize({ action: 'snooze', session_id: 'other-session', snoozed_until: until, note: 'after CI' })
    expect(snoozed).toMatchObject({ ok: true })
    expect(await viewOf('other-session')).toMatchObject({ snoozedUntil: Date.parse(until), snoozeNote: 'after CI' })

    expect(await organize({ action: 'unsnooze', session_id: 'other-session' })).toMatchObject({ ok: true, text: 'Session other-session is awake.' })
    expect(await viewOf('other-session')).toEqual(EMPTY_SESSION_VIEW)
  })

  test("archives a session in the person's own list and returns it, keeping its settle", async () => {
    // WHY: archive takes a session out of the person's list on every device. Its
    // reverse must put it back where it was, not make it active.
    await organize({ action: 'settle' })
    expect(await organize({ action: 'archive' })).toMatchObject({ ok: true, text: 'This session is archived.' })
    expect((await viewOf('caller')).archivedAt).not.toBeNull()
    expect(await organize({ action: 'archive' })).toMatchObject({ text: 'This session was archived already.' })

    expect(await organize({ action: 'unarchive' })).toMatchObject({ ok: true, text: 'This session is back in the list.' })
    expect((await viewOf('caller')).archivedAt).toBeNull()
    expect(await stateOf('caller')).toMatchObject({ settledBy: 'person' })
  })

  test('refuses a snooze the list could not show', async () => {
    // WHY: a wake time in the past is a snooze that already ended, and a
    // settled session is not snoozed. Either write would leave the list lying.
    expect(await organize({ action: 'snooze', snoozed_until: '2026-10-10T00:00:00Z' })).toMatchObject({ ok: false })
    expect(await organize({ action: 'snooze' })).toMatchObject({ ok: false })

    await organize({ action: 'settle' })
    expect(await organize({ action: 'snooze', snoozed_until: '2026-10-12T00:00:00Z' })).toMatchObject({ ok: false })
    expect(await viewOf('caller')).toEqual(EMPTY_SESSION_VIEW)
  })

  test('refuses a session that does not exist instead of writing a stray row', async () => {
    const result = await organize({ action: 'settle', session_id: 'missing' })
    expect(result).toMatchObject({ ok: false, text: 'Session missing not found.' })
    expect(await stateOf('missing')).toEqual(UNSETTLED_SESSION_STATE)
  })

  test('mark_unread clears the read boundary and tells listeners, so every client sees it', async () => {
    // WHY: the agent has no client connection. The host broadcasts read state
    // from the data layer, so a change made here reaches every device.
    await states.markSessionViewed('caller', NOW - 1_000)
    const heard: Array<[string, number | null]> = []
    const stop = states.onSessionReadStateChanged((sessionId, viewedAt) => heard.push([sessionId, viewedAt]))
    try {
      expect(await organize({ action: 'mark_unread' })).toMatchObject({ ok: true })
    } finally {
      stop()
    }
    expect(heard).toEqual([['caller', null]])
    // The boundary is gone: an older read lands again.
    expect(await states.markSessionViewed('caller', NOW - 5_000)).toBe(NOW - 5_000)
  })
})
