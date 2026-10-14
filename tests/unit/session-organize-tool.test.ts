import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from './helpers/test-db'
import { ACTIVE_SESSION_STATE } from '@solus/contracts/session-state'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * organize_session moves a session in the person's list the way the sidebar
 * does, and every move it makes reaches clients through the host's events.
 */

let tool: typeof import('@solus/server/execution/agents/tools/session-organize-tool')
let states: typeof import('@solus/server/data/sessions/session-states')
let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let closeDb: typeof import('@solus/server/db')['closeDb']
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
const NOW = Date.parse('2026-10-11T12:00:00Z')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-organize-tool-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tool = await import('@solus/server/execution/agents/tools/session-organize-tool')
  states = await import('@solus/server/data/sessions/session-states')
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  ;({ closeDb } = await import('@solus/server/db'))
  // Only "other-session" exists besides the caller.
  sessionTools.setSessionController({
    getSessionInfo: async (sessionId: string) => sessionId === 'other-session' ? { sessionId } : null,
  } as never)
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

function stateOf(sessionId: string) {
  return new states.SessionShelf(sessionId).state()
}

describe('organize_session', () => {
  test('settles the calling session by default, and unsettle reverses it', async () => {
    expect(await tool.organizeSession({ action: 'settle' }, 'caller', NOW)).toMatchObject({ ok: true })
    expect(await stateOf('caller')).toMatchObject({ settledBy: 'person', settledAt: NOW })

    expect(await tool.organizeSession({ action: 'unsettle' }, 'caller', NOW)).toMatchObject({ ok: true })
    expect(await stateOf('caller')).toEqual(ACTIVE_SESSION_STATE)
  })

  test('snoozes another session until a future time with a note, and unsnooze wakes it', async () => {
    const until = '2026-10-12T09:00:00Z'
    const snoozed = await tool.organizeSession({ action: 'snooze', session_id: 'other-session', snoozed_until: until, note: 'after CI' }, 'caller', NOW)
    expect(snoozed).toMatchObject({ ok: true })
    expect(await stateOf('other-session')).toMatchObject({ snoozedUntil: Date.parse(until), snoozeNote: 'after CI' })

    expect(await tool.organizeSession({ action: 'unsnooze', session_id: 'other-session' }, 'caller', NOW)).toMatchObject({ ok: true })
    expect(await stateOf('other-session')).toEqual(ACTIVE_SESSION_STATE)
  })

  test('archives a session and returns it to the list, keeping its shelf', async () => {
    // WHY: archive takes a session out of the list on every device. Its
    // reverse must put it back where it was, not make it active.
    await tool.organizeSession({ action: 'settle' }, 'caller', NOW)
    expect(await tool.organizeSession({ action: 'archive' }, 'caller', NOW)).toMatchObject({ ok: true, text: 'This session is archived.' })
    expect(await stateOf('caller')).toMatchObject({ archivedAt: NOW, settledBy: 'person' })
    expect(await tool.organizeSession({ action: 'archive' }, 'caller', NOW)).toMatchObject({ text: 'This session was archived already.' })

    expect(await tool.organizeSession({ action: 'unarchive' }, 'caller', NOW)).toMatchObject({ ok: true, text: 'This session is back in the list.' })
    expect(await stateOf('caller')).toMatchObject({ archivedAt: null, settledBy: 'person' })
  })

  test('refuses a snooze the list could not show', async () => {
    // WHY: a wake time in the past is a snooze that already ended, and a
    // settled session is not snoozed. Either write would leave the list lying.
    const past = await tool.organizeSession({ action: 'snooze', snoozed_until: '2026-10-10T00:00:00Z' }, 'caller', NOW)
    expect(past).toMatchObject({ ok: false })
    expect(await tool.organizeSession({ action: 'snooze' }, 'caller', NOW)).toMatchObject({ ok: false })

    await tool.organizeSession({ action: 'settle' }, 'caller', NOW)
    const settled = await tool.organizeSession({ action: 'snooze', snoozed_until: '2026-10-12T00:00:00Z' }, 'caller', NOW)
    expect(settled).toMatchObject({ ok: false })
    expect(await stateOf('caller')).toMatchObject({ snoozedUntil: null })
  })

  test('refuses a session that does not exist instead of writing a stray row', async () => {
    const result = await tool.organizeSession({ action: 'settle', session_id: 'missing' }, 'caller', NOW)
    expect(result).toMatchObject({ ok: false, text: 'Session missing not found.' })
    expect(await stateOf('missing')).toEqual(ACTIVE_SESSION_STATE)
  })

  test('mark_unread clears the read boundary and tells listeners, so every client sees it', async () => {
    // WHY: the agent has no client connection. The host broadcasts read state
    // from the data layer, so a change made here reaches every device.
    await states.markSessionViewed('caller', NOW - 1_000)
    const heard: Array<[string, number | null]> = []
    const stop = states.onSessionReadStateChanged((sessionId, viewedAt) => heard.push([sessionId, viewedAt]))
    try {
      expect(await tool.organizeSession({ action: 'mark_unread' }, 'caller', NOW)).toMatchObject({ ok: true })
    } finally {
      stop()
    }
    expect(heard).toEqual([['caller', null]])
    // The boundary is gone: an older read lands again.
    expect(await states.markSessionViewed('caller', NOW - 5_000)).toBe(NOW - 5_000)
  })
})
