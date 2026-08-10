import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('../../src/main/db')
type PinnedSessionsModule = typeof import('../../src/main/sessions/pinned-sessions')

let dataDir: string
let db: DbModule
let pinnedSessions: PinnedSessionsModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pinned-sessions-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('../../src/main/db')
  pinnedSessions = await import('../../src/main/sessions/pinned-sessions')
})

afterEach(() => {
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  }
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('pinned session manifest', () => {
  test('round-trips the session host with the pinned entry', async () => {
    const pin = {
      sessionId: 'session-1',
      serverId: 'studio',
      provider: 'codex' as const,
      title: 'Scoped session',
      cwd: '/repo',
      pinnedAt: 42,
    }

    expect(await pinnedSessions.togglePinnedSession(pin)).toEqual([pin])
    expect(await pinnedSessions.readManifest()).toEqual([pin])
  })

  test('keeps equal provider session ids distinct across hosts', async () => {
    const studio = {
      sessionId: 'shared-id',
      serverId: 'studio',
      provider: 'codex' as const,
      title: 'Studio copy',
      cwd: '/studio/repo',
      pinnedAt: 1,
    }
    const laptop = {
      ...studio,
      serverId: 'laptop',
      title: 'Laptop copy',
      cwd: '/laptop/repo',
      pinnedAt: 2,
    }

    await pinnedSessions.togglePinnedSession(studio)
    expect(await pinnedSessions.togglePinnedSession(laptop)).toEqual([laptop, studio])
    expect(await pinnedSessions.togglePinnedSession(studio)).toEqual([laptop])
  })
})
