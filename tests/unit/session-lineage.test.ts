import { Database } from 'bun:sqlite'
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type LineageRepository = typeof import('../../src/main/sessions/session-lineage')
let repository: LineageRepository
let db: Database

beforeAll(async () => {
  repository = await import('../../src/main/sessions/session-lineage')
})

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE session_lineage_members (
      session_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      cwd TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, position)
    );
    CREATE UNIQUE INDEX session_lineage_member_provider_session
      ON session_lineage_members(provider, provider_session_id)
      WHERE provider_session_id IS NOT NULL;
  `)
})

describe('session lineage', () => {
  test('leaves unmatched provider transcripts outside the lookup', () => {
    expect(repository.resolveSessionLineage('codex', 'unclaimed', db)).toBeNull()
  })

  test('registration is first writer wins, so two clients cannot name one thread twice', () => {
    // WHY: this is the whole point of the durable record. Desktop and web each read
    // the same provider thread off disk and each mint their own uuid for it. The
    // second one must be answered with the first one's id, not obeyed — otherwise
    // the two clients hold two addresses for one conversation and each sees only
    // the turns it started.
    const first = repository.registerSessionLineage(
      { sessionId: 'desktop-uuid', provider: 'claude-code', providerSessionId: 'claude-1', cwd: '/project', now: 10 },
      db,
    )
    expect(first.sessionId).toBe('desktop-uuid')

    const second = repository.registerSessionLineage(
      { sessionId: 'web-uuid', provider: 'claude-code', providerSessionId: 'claude-1', cwd: '/project', now: 20 },
      db,
    )
    expect(second.sessionId).toBe('desktop-uuid')
    expect(repository.resolveSessionLineage('claude-code', 'claude-1', db)?.sessionId).toBe('desktop-uuid')
    // The loser must not have left a row behind under its own name.
    expect(repository.resolveSessionLineageById('web-uuid', db)).toBeNull()
  })

  test('registration survives a restart, so a cold server still resolves one id', () => {
    // WHY: the binding used to live only in an in-memory Map. After a restart both
    // clients would re-mint, which is the same split by another route.
    repository.registerSessionLineage(
      { sessionId: 'solus-1', provider: 'codex', providerSessionId: 'codex-1', cwd: '/project', now: 10 },
      db,
    )
    expect(repository.stableSessionIdForProviderThread('codex-1', db)).toBe('solus-1')
  })

  test('an ordinary session is a lineage of one, so nothing reads as a handoff', () => {
    // WHY: every call site that treated "a resolution exists" as "this is a handoff"
    // now has to read members.length instead. Composite transcript loading and the
    // picker's cheap preview both hang off this distinction.
    repository.registerSessionLineage(
      { sessionId: 'solus-1', provider: 'codex', providerSessionId: 'codex-1', cwd: '/project', now: 10 },
      db,
    )
    const resolved = repository.resolveSessionLineage('codex', 'codex-1', db)
    expect(resolved?.members).toHaveLength(1)
    expect(resolved?.active.providerSessionId).toBe('codex-1')
  })

  test('registering does not append beside a handoff that is mid-switch', () => {
    // WHY: session_init fires for the handoff's target too. beginSessionHandoff owns
    // that provisional row; a second row appended here would fork the lineage and
    // lose the switch.
    repository.beginSessionHandoff({
      sessionId: 'solus-1',
      sourceProvider: 'codex',
      sourceProviderSessionId: 'codex-1',
      targetProvider: 'claude-code',
      cwd: '/project',
      now: 10,
    }, db)
    const registered = repository.registerSessionLineage(
      { sessionId: 'solus-1', provider: 'claude-code', providerSessionId: 'claude-1', cwd: '/project', now: 20 },
      db,
    )
    expect(registered.members).toHaveLength(2)
    expect(registered.active.providerSessionId).toBeNull()

    repository.completeSessionHandoff('solus-1', 'claude-code', 'claude-1', '/project', db, 30)
    expect(repository.resolveSessionLineage('claude-code', 'claude-1', db)?.sessionId).toBe('solus-1')
  })

  test('resolves every member to one ordered chain and its latest endpoint', () => {
    repository.beginSessionHandoff({
      sessionId: 'solus-1',
      sourceProvider: 'codex',
      sourceProviderSessionId: 'codex-1',
      targetProvider: 'claude-code',
      cwd: '/project',
      now: 10,
    }, db)
    repository.completeSessionHandoff('solus-1', 'claude-code', 'claude-1', '/project', db, 20)
    repository.beginSessionHandoff({
      sessionId: 'solus-1',
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
      const resolved = repository.resolveSessionLineage(provider, providerSessionId, db)
      expect(resolved?.sessionId).toBe('solus-1')
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
      sessionId: 'solus-2',
      sourceProvider: 'codex',
      sourceProviderSessionId: 'codex-source',
      targetProvider: 'claude-code',
      cwd: '/project',
      now: 10,
    }, db)

    expect(repository.cancelProvisionalSessionHandoff('solus-2', db, 20)).toBeNull()
    expect(repository.resolveSessionLineage('codex', 'codex-source', db)).toBeNull()
  })

  test('reopens the previous endpoint when a later provisional handoff is cancelled', () => {
    repository.beginSessionHandoff({
      sessionId: 'solus-3',
      sourceProvider: 'codex',
      sourceProviderSessionId: 'codex-1',
      targetProvider: 'claude-code',
      cwd: '/project',
      now: 10,
    }, db)
    repository.completeSessionHandoff('solus-3', 'claude-code', 'claude-1', '/project', db, 20)
    repository.beginSessionHandoff({
      sessionId: 'solus-3',
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
