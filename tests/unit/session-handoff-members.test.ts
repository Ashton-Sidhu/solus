import { Database } from 'bun:sqlite'
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type HandoffRepository = typeof import('../../src/main/sessions/session-handoff-members')
let repository: HandoffRepository
let db: Database

beforeAll(async () => {
  repository = await import('../../src/main/sessions/session-handoff-members')
})

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE session_handoff_members (
      handoff_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      cwd TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (handoff_id, position)
    );
    CREATE UNIQUE INDEX session_handoff_member_provider_session
      ON session_handoff_members(provider, provider_session_id)
      WHERE provider_session_id IS NOT NULL;
  `)
})

describe('session handoff members', () => {
  test('leaves unmatched provider transcripts outside the lookup', () => {
    expect(repository.resolveSessionHandoff('codex', 'unclaimed', db)).toBeNull()
  })

  test('resolves every member to one ordered chain and its latest endpoint', () => {
    repository.beginSessionHandoff({
      handoffId: 'solus-1',
      sourceProvider: 'codex',
      sourceProviderSessionId: 'codex-1',
      targetProvider: 'claude-code',
      cwd: '/project',
      now: 10,
    }, db)
    repository.completeSessionHandoff('solus-1', 'claude-code', 'claude-1', '/project', db, 20)
    repository.beginSessionHandoff({
      handoffId: 'solus-1',
      sourceProvider: 'claude-code',
      sourceProviderSessionId: 'claude-1',
      targetProvider: 'codex',
      cwd: '/project',
      now: 30,
    }, db)
    repository.completeSessionHandoff('solus-1', 'codex', 'codex-2', '/project', db, 40)

    for (const [provider, providerSessionId] of [
      ['codex', 'codex-1'],
      ['claude-code', 'claude-1'],
      ['codex', 'codex-2'],
    ] as const) {
      const resolved = repository.resolveSessionHandoff(provider, providerSessionId, db)
      expect(resolved?.handoffId).toBe('solus-1')
      expect(resolved?.members.map((member) => member.providerSessionId)).toEqual([
        'codex-1',
        'claude-1',
        'codex-2',
      ])
      expect(resolved?.active).toMatchObject({ provider: 'codex', providerSessionId: 'codex-2' })
    }
  })

  test('removes a first provisional handoff when the user switches back', () => {
    repository.beginSessionHandoff({
      handoffId: 'solus-2',
      sourceProvider: 'codex',
      sourceProviderSessionId: 'codex-source',
      targetProvider: 'claude-code',
      cwd: '/project',
      now: 10,
    }, db)

    expect(repository.cancelProvisionalSessionHandoff('solus-2', db, 20)).toBeNull()
    expect(repository.resolveSessionHandoff('codex', 'codex-source', db)).toBeNull()
  })

  test('reopens the previous endpoint when a later provisional handoff is cancelled', () => {
    repository.beginSessionHandoff({
      handoffId: 'solus-3',
      sourceProvider: 'codex',
      sourceProviderSessionId: 'codex-1',
      targetProvider: 'claude-code',
      cwd: '/project',
      now: 10,
    }, db)
    repository.completeSessionHandoff('solus-3', 'claude-code', 'claude-1', '/project', db, 20)
    repository.beginSessionHandoff({
      handoffId: 'solus-3',
      sourceProvider: 'claude-code',
      sourceProviderSessionId: 'claude-1',
      targetProvider: 'codex',
      cwd: '/project',
      now: 30,
    }, db)

    const restored = repository.cancelProvisionalSessionHandoff('solus-3', db, 40)
    expect(restored?.members).toHaveLength(2)
    expect(restored?.active).toMatchObject({
      provider: 'claude-code',
      providerSessionId: 'claude-1',
      endedAt: null,
    })
  })
})
