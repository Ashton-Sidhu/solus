import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexAppServerClient } from '@solus/server/execution/agents/codex/codex-agent'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const dataDir = mkdtempSync(join(tmpdir(), 'solus-thread-import-db-'))
const previous = process.env.SOLUS_DATA_DIR
let importClaudeThread: typeof import('@solus/server/execution/agents/claude/claude-thread-import')['importClaudeThread']
let claudeThreadFiles: typeof import('@solus/server/execution/agents/claude/claude-session-helpers')['claudeThreadFiles']
let importCodexThread: typeof import('@solus/server/execution/agents/codex/codex-thread-import')['importCodexThread']
let importThreadFiles: typeof import('@solus/server/execution/agents/thread-import')['importThreadFiles']
let safeThreadPath: typeof import('@solus/server/execution/agents/thread-import')['safeThreadPath']
let sessionIdOfThread: typeof import('@solus/server/data/sessions/session-lineage')['sessionIdOfThread']
let encodePathAsFolder: typeof import('@solus/server/execution/agents/utils')['encodePathAsFolder']
const dirs: string[] = []
const threadId = '0f6f3f0e-5d6b-4c57-9a55-1f4b3c2d1e00'
const cwd = '/tmp/new-worktree'

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ importClaudeThread } = await import('@solus/server/execution/agents/claude/claude-thread-import'))
  ;({ claudeThreadFiles } = await import('@solus/server/execution/agents/claude/claude-session-helpers'))
  ;({ importCodexThread } = await import('@solus/server/execution/agents/codex/codex-thread-import'))
  ;({ importThreadFiles, safeThreadPath } = await import('@solus/server/execution/agents/thread-import'))
  ;({ sessionIdOfThread } = await import('@solus/server/data/sessions/session-lineage'))
  ;({ encodePathAsFolder } = await import('@solus/server/execution/agents/utils'))
})
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
afterAll(async () => {
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
  rmSync(dataDir, { recursive: true, force: true })
})
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'solus-thread-import-')); dirs.push(dir); return dir }
function source(dir: string, content: string) { const path = join(dir, 'source'); writeFileSync(path, content); return path }

describe('thread import', () => {
  // WHY: Claude resumes by the thread id in the new worktree folder, including its subagent files.
  test('Claude writes under the new worktree folder and exports the same paths', async () => {
    const dir = fixture(), home = join(dir, 'claude')
    const main = source(dir, '{}\n')
    const child = join(dir, 'child'); writeFileSync(child, 'child\n')
    const files = [{ relativePath: `${threadId}.jsonl`, path: main }, { relativePath: `${threadId}/subagents/a.jsonl`, path: child }]
    const result = await importClaudeThread({ sessionId: 'session-claude', threadId, files, cwd }, home)
    const transcript = join(home, 'projects', encodePathAsFolder(cwd), `${threadId}.jsonl`)
    expect(result.bytesWritten).toBe(9)
    expect((await claudeThreadFiles(transcript, threadId)).map((file) => file.relativePath).sort()).toEqual(files.map((file) => file.relativePath).sort())
    expect(readFileSync(transcript, 'utf8')).toBe('{}\n')
    expect(statSync(transcript).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, 'projects', encodePathAsFolder(cwd))).mode & 0o777).toBe(0o700)
  })

  // WHY: The indexer sees a new Claude transcript as soon as it lands; it must see the session binding then.
  test('lineage exists when the first transcript is written', async () => {
    const dir = fixture(), home = join(dir, 'home'), path = source(dir, '{}\n')
    const result = await importClaudeThread(
      { sessionId: 'session-lineage', threadId: 'thread-lineage', files: [{ relativePath: 'thread-lineage.jsonl', path }], cwd },
      home,
      async (root, files, signal) => {
        expect(sessionIdOfThread('thread-lineage')).toBe('session-lineage')
        expect(existsSync(join(root, 'thread-lineage.jsonl'))).toBe(false)
        return importThreadFiles(root, files, signal)
      },
    )
    expect(result.bytesWritten).toBe(3)
    expect(existsSync(join(home, 'projects', encodePathAsFolder(cwd), 'thread-lineage.jsonl'))).toBe(true)
  })


  // WHY: A provider switch keeps both imported threads in the one session lineage.
  test('later imported threads extend the same lineage', async () => {
    const { ensureImportedSessionLineage, resolveSessionLineageById } = await import('@solus/server/data/sessions/session-lineage')
    ensureImportedSessionLineage({ sessionId: 'session-multi', provider: 'claude-code', threadId: 'first-thread', cwd })
    ensureImportedSessionLineage({ sessionId: 'session-multi', provider: 'codex', threadId: 'second-thread', cwd })
    expect(resolveSessionLineageById('session-multi')?.members.map((member) => member.providerSessionId)).toEqual(['first-thread', 'second-thread'])
  })

  // WHY: A host with an older copy keeps its inode and gains only bytes it lacks.
  test('an older prefix is appended, and an identical file is untouched', async () => {
    const dir = fixture(), root = join(dir, 'out'); mkdirSync(root)
    const path = source(dir, 'abcdef'), destination = join(root, 'file')
    writeFileSync(destination, 'abc')
    const inode = statSync(destination).ino
    expect((await importThreadFiles(root, [{ relativePath: 'file', path }])).files[0]).toEqual({ relativePath: 'file', status: 'appended', bytes: 3 })
    expect(readFileSync(destination, 'utf8')).toBe('abcdef')
    expect(statSync(destination).ino).toBe(inode)
    const mtime = statSync(destination).mtimeMs
    expect((await importThreadFiles(root, [{ relativePath: 'file', path }])).files[0].status).toBe('identical')
    expect(statSync(destination).mtimeMs).toBe(mtime)
  })

  // WHY: A divergent local provider file is valuable data. Import must keep it byte for byte.
  test('a divergent destination returns conflict without overwrite', async () => {
    const dir = fixture(), root = join(dir, 'out'); mkdirSync(root)
    const path = source(dir, 'remote'), destination = join(root, 'file'); writeFileSync(destination, 'local')
    expect((await importThreadFiles(root, [{ relativePath: 'file', path }])).files[0].status).toBe('conflict')
    expect(readFileSync(destination, 'utf8')).toBe('local')
  })

  // WHY: after a refused push, choosing the newer cloud copy must install its
  // provider thread so the next turn resumes the accepted history.
  test('an explicit newer-copy import replaces a divergent thread', async () => {
    const dir = fixture(), root = join(dir, 'out'); mkdirSync(root)
    const path = source(dir, 'cloud'), destination = join(root, 'file'); writeFileSync(destination, 'local')
    expect((await importThreadFiles(root, [{ relativePath: 'file', path }], undefined, true)).files[0].status).toBe('written')
    expect(readFileSync(destination, 'utf8')).toBe('cloud')
  })

  // WHY: A manifest comes from another host, so it cannot name files outside the provider home.
  test('hostile manifest paths are refused', async () => {
    const root = fixture()
    for (const name of ['../escape', '/tmp/escape', 'a/../escape', 'a\\..\\escape', 'C:/escape']) {
      expect(() => safeThreadPath(root, name)).toThrow()
    }
  })

  // WHY: A stopped sync must not make a new provider file.
  test('an abort stops import before a write', async () => {
    const dir = fixture(), root = join(dir, 'out'), path = source(dir, 'data'), signal = AbortSignal.abort()
    await expect(importThreadFiles(root, [{ relativePath: 'file', path }], signal)).rejects.toThrow()
    expect(existsSync(join(root, 'file'))).toBe(false)
  })

  // WHY: Codex reads its state row first and caches turns. Unload, write to that row's path, then resume with this host's cwd.
  test('Codex unloads, writes to the state path, and resumes after the write', async () => {
    const dir = fixture(), home = join(dir, 'codex'), path = source(dir, 'new history')
    const statePath = join(home, 'sessions', '2026', 'rollout-old.jsonl')
    mkdirSync(join(home, 'sessions', '2026'), { recursive: true })
    writeFileSync(statePath, 'new ')
    const calls: string[] = []
    const client = { async request(method: string, params: { cwd?: string }) {
      calls.push(method)
      if (method === 'thread/read') return { thread: { path: statePath } }
      if (method === 'thread/unsubscribe') { expect(readFileSync(statePath, 'utf8')).toBe('new '); return { status: 'unsubscribed' } }
      if (method === 'thread/resume') { expect(readFileSync(statePath, 'utf8')).toBe('new history'); expect(params.cwd).toBe(cwd); return { thread: { id: threadId } } }
      throw new Error(method)
    } } as unknown as CodexAppServerClient
    const result = await importCodexThread({ sessionId: 'session-codex', threadId, files: [{ relativePath: 'sessions/2026/rollout-new.jsonl', path }], cwd }, home, client)
    expect(result.bytesWritten).toBe(7)
    expect(calls).toEqual(['thread/read', 'thread/unsubscribe', 'thread/resume'])
    expect(existsSync(join(home, 'sessions', '2026', 'rollout-new.jsonl'))).toBe(false)
  })
})
