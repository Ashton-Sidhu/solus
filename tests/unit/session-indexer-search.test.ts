import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { encodePathAsFolder, SOLUS_WORKTREE_PATH_MARKER } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

// The production DB layer imports `node:sqlite` (available in Electron/Node),
// which Bun's test runtime does not provide. bun:sqlite is API-compatible for
// what the indexer uses (prepare/run/get/all/exec, lastInsertRowid, FTS5), so
// shim it in before the DB module loads. Because mock.module is not hoisted,
// the modules under test are imported dynamically in beforeAll, after this runs.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type IndexerModule = typeof import('@solus/server/db/session-indexer')
type DbModule = typeof import('@solus/server/db')
let indexer: IndexerModule
let closeDb: DbModule['closeDb']
let getDb: DbModule['getDb']

const PROJECT = encodePathAsFolder('/Users/test/proj')
const OTHER_PROJECT = encodePathAsFolder('/Users/test/other')

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-idx-'))
  process.env.SOLUS_DATA_DIR = dataDir
  indexer = await import('@solus/server/db/session-indexer')
  ;({ closeDb, getDb } = await import('@solus/server/db'))
})
afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

afterEach(() => {
  // Fresh DB per test: closing clears the singleton, and a new getDb() re-runs
  // migrations against a clean file.
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

function msg(role: string, content: string, timestamp: number): SessionLoadMessage {
  return { role, content, timestamp }
}

describe('getIndexedSession', () => {
  test('resolves a non-resident session written by persistIndexedSessionStart', () => {
    indexer.persistIndexedSessionStart(
      'sess-1',
      'codex',
      '/Users/test/proj',
      PROJECT,
      'gpt-5.5',
      'high',
      'Fix task session labels',
    )
    const meta = indexer.getIndexedSession('sess-1')
    expect(meta).not.toBeNull()
    expect(meta!.sessionId).toBe('sess-1')
    expect(meta!.provider).toBe('codex')
    // WHY: task links join this row immediately after session_init, before the
    // provider history indexer has had a chance to rediscover the transcript.
    expect(meta!.firstMessage).toBe('Fix task session labels')
    expect(meta!.model).toBe('gpt-5.5')
    expect(meta!.reasoningEffort).toBe('high')
  })

  test('maps stored provider "claude" back to claude-code', () => {
    indexer.persistIndexedSessionStart('sess-c', 'claude-code', '/Users/test/proj', PROJECT, 'claude-sonnet-5', 'medium')
    expect(indexer.getIndexedSession('sess-c')!.provider).toBe('claude-code')
  })

  test('returns null for an unknown id', () => {
    expect(indexer.getIndexedSession('nope')).toBeNull()
  })
})

describe('indexSessionMessages', () => {
  test('produces an FTS hit for an indexed Codex session', () => {
    indexer.persistIndexedSessionStart('sess-2', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('sess-2', 'codex', [
      msg('user', 'please refactor the widget factory', 10),
      msg('assistant', 'refactored the widget successfully', 20),
    ])
    const hits = indexer.searchIndexedSessions('widget')
    expect(hits.some((h) => h.session.sessionId === 'sess-2')).toBe(true)
  })

  test('re-indexing replaces rather than duplicates messages', () => {
    indexer.persistIndexedSessionStart('sess-3', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('sess-3', 'codex', [msg('user', 'zebra alpha', 10)])
    indexer.indexSessionMessages('sess-3', 'codex', [msg('user', 'zebra beta', 20)])
    const rows = indexer.getSessionMessages('sess-3')
    expect(rows.length).toBe(1)
    expect(rows[0].text).toBe('zebra beta')
  })

  test('drops tool and empty messages', () => {
    indexer.persistIndexedSessionStart('sess-4', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('sess-4', 'codex', [
      msg('user', 'keep me', 10),
      { role: 'tool', content: 'tool noise', timestamp: 15, toolName: 'Bash' },
      msg('assistant', '   ', 20),
    ])
    expect(indexer.getSessionMessages('sess-4').map((r) => r.text)).toEqual(['keep me'])
  })
})

describe('searchIndexedSessions filters', () => {
  function seed(): void {
    indexer.persistIndexedSessionStart('s-a', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('s-a', 'codex', [
      msg('user', 'flamingo question from user', 1_000),
      msg('assistant', 'flamingo answer from assistant', 2_000),
    ])
    indexer.persistIndexedSessionStart('s-old', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('s-old', 'codex', [msg('user', 'flamingo ancient message', 100)])
    indexer.persistIndexedSessionStart('s-other', 'codex', '/Users/test/other', OTHER_PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('s-other', 'codex', [msg('user', 'flamingo elsewhere', 3_000)])
  }

  test('searches all projects by default', () => {
    seed()
    const ids = new Set(indexer.searchIndexedSessions('flamingo').map((h) => h.session.sessionId))
    expect(ids.has('s-a')).toBe(true)
    expect(ids.has('s-other')).toBe(true) // a different project is now included
  })

  test('projectRoot scopes to one git-root', () => {
    seed()
    const hits = indexer.searchIndexedSessions('flamingo', { projectRoot: '/Users/test/proj' })
    expect(hits.some((h) => h.session.sessionId === 's-other')).toBe(false)
    expect(hits.some((h) => h.session.sessionId === 's-a')).toBe(true)
  })

  test('role filter narrows to assistant messages', () => {
    seed()
    const assistantHits = indexer.searchIndexedSessions('flamingo', { projectRoot: '/Users/test/proj', role: 'assistant' })
    expect(assistantHits.length).toBe(1)
    expect(assistantHits[0].session.sessionId).toBe('s-a')
  })

  test('sinceTs excludes messages older than the cutoff', () => {
    seed()
    const recent = indexer.searchIndexedSessions('flamingo', { sinceTs: 500 })
    const ids = new Set(recent.map((h) => h.session.sessionId))
    expect(ids.has('s-a')).toBe(true)
    expect(ids.has('s-old')).toBe(false) // ts 100 < 500
  })
})

describe('project_root (git-root grouping)', () => {
  test('populates project_root from a plain cwd', () => {
    indexer.persistIndexedSessionStart('pr-1', 'codex', '/Users/test/solus', encodePathAsFolder('/Users/test/solus'), 'gpt-5.5', 'high')
    expect(indexer.getIndexedSession('pr-1')!.projectRoot).toBe('/Users/test/solus')
  })

  test('collapses a worktree cwd to its originating project root', () => {
    const root = '/Users/test/solus'
    const worktree = `${root}${SOLUS_WORKTREE_PATH_MARKER}generate-names`
    indexer.persistIndexedSessionStart('pr-wt', 'codex', worktree, encodePathAsFolder(worktree), 'gpt-5.5', 'high')
    // worktree and a plain repo session share ONE project_root.
    expect(indexer.getIndexedSession('pr-wt')!.projectRoot).toBe(root)
  })

  test('a project scope includes its worktrees', () => {
    const root = '/Users/test/solus'
    const worktree = `${root}${SOLUS_WORKTREE_PATH_MARKER}names`
    indexer.persistIndexedSessionStart('repo-sess', 'codex', root, encodePathAsFolder(root), 'gpt-5.5', 'high')
    indexer.indexSessionMessages('repo-sess', 'codex', [msg('user', 'pelican in the repo', 10)])
    indexer.persistIndexedSessionStart('wt-sess', 'codex', worktree, encodePathAsFolder(worktree), 'gpt-5.5', 'high')
    indexer.indexSessionMessages('wt-sess', 'codex', [msg('user', 'pelican in the worktree', 20)])
    const ids = new Set(indexer.searchIndexedSessions('pelican', { projectRoot: root }).map((h) => h.session.sessionId))
    expect(ids.has('repo-sess')).toBe(true)
    expect(ids.has('wt-sess')).toBe(true) // worktree included via shared project_root
  })

  test('listProjectRoots returns distinct roots with names and counts', () => {
    indexer.persistIndexedSessionStart('lp-1', 'codex', '/Users/test/solus', encodePathAsFolder('/Users/test/solus'), 'gpt-5.5', 'high')
    indexer.persistIndexedSessionStart('lp-2', 'codex', '/Users/test/solus', encodePathAsFolder('/Users/test/solus'), 'gpt-5.5', 'high')
    indexer.persistIndexedSessionStart('lp-3', 'codex', '/Users/test/solus', encodePathAsFolder('/Users/test/solus'), 'gpt-5.5', 'high')
    const roots = indexer.listProjectRoots()
    const solus = roots.find((r) => r.projectRoot === '/Users/test/solus')
    expect(solus).toBeDefined()
    expect(solus!.name).toBe('solus')
    expect(solus!.count).toBe(2)
    expect(roots.some((r) => r.name === 'solus')).toBe(true)
  })
})

describe('getCodexSessionsWithMessages', () => {
  test('returns only the ids that have an indexed body', () => {
    indexer.persistIndexedSessionStart('has-body', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('has-body', 'codex', [msg('user', 'hi there', 10)])
    // Row exists (e.g. written at session_init) but no body indexed yet.
    indexer.persistIndexedSessionStart('no-body', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    const withMessages = indexer.getCodexSessionsWithMessages(['has-body', 'no-body', 'never-seen'])
    expect(withMessages.has('has-body')).toBe(true)
    expect(withMessages.has('no-body')).toBe(false)   // → refresh will re-read its body
    expect(withMessages.has('never-seen')).toBe(false)
  })
})

describe('getSessionMessages', () => {
  test('returns user/assistant messages in ts order', () => {
    indexer.persistIndexedSessionStart('s-order', 'codex', '/Users/test/proj', PROJECT, 'gpt-5.5', 'high')
    indexer.indexSessionMessages('s-order', 'codex', [
      msg('assistant', 'second', 200),
      msg('user', 'first', 100),
    ])
    expect(indexer.getSessionMessages('s-order').map((r) => r.text)).toEqual(['first', 'second'])
  })
})

describe('sessionIndexComplete', () => {
  // A session list served from the index costs one query; the fallback reads the
  // head of every transcript in the project and its worktrees — for one busy
  // project here, 82 MB. Which of the two a launch gets is this answer.
  const SWEEP_MARKER = 'claude-session-index-swept-at'

  test('a first-ever launch reads the transcripts instead of a half-filled index', () => {
    // WHY: mid-first-sweep the index holds an arbitrary prefix of the store.
    // Answering from it would show a project that looks complete and is not.
    indexer.stopSessionIndexer()
    expect(indexer.sessionIndexComplete()).toBe(false)
  })

  test('a later launch serves lists from the index before its own sweep runs', () => {
    // WHY: the sweep only catches up on what changed while the app was closed,
    // so making the picker wait for it bought nothing and cost the whole scan.
    getDb().prepare('INSERT INTO kv(key, value) VALUES (?, ?)').run(SWEEP_MARKER, String(Date.now()))
    // A new process starts with no cached answer and no sweep of its own.
    indexer.stopSessionIndexer()

    expect(indexer.sessionIndexComplete()).toBe(true)
  })
})

describe('resetSession', () => {
  // A reset means "re-read this file from offset 0" — it must clear the message
  // index (or re-reading duplicates every row) and NOTHING else. The sessions
  // row is the durable record of a session's model config, written once at
  // session_init; promptSession depends on it to re-launch any non-resident
  // session. Agent-created sessions get exactly one session_init, and the file
  // watcher resets every brand-new JSONL, so a delete here is a permanent wipe.
  test('clears indexed messages but never de-lists the session', () => {
    indexer.persistIndexedSessionStart('child-1', 'claude-code', '/Users/test/proj', PROJECT, 'claude-opus-5', 'low')
    indexer.indexSessionMessages('child-1', 'claude-code', [
      msg('user', 'talk to me about the weather', 10),
    ])
    indexer.resetSession('/tmp/fake/child-1.jsonl', 'child-1', 42, Date.now())
    expect(indexer.getSessionMessages('child-1')).toEqual([])
    const meta = indexer.getIndexedSession('child-1')
    expect(meta).not.toBeNull()
    expect(meta!.model).toBe('claude-opus-5')
    expect(meta!.reasoningEffort).toBe('low')
  })
})
