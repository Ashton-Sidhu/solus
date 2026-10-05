import { beforeAll, afterAll, afterEach, expect, test, mock, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RestartRun } from '@solus/server/data/sessions/session-restart-store'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const previousDataDir = process.env.SOLUS_DATA_DIR
let directory: string
let Store: typeof import('@solus/server/data/sessions/session-restart-store')['SessionRestartStore']
let closeDb: typeof import('@solus/server/db')['closeDb']
let getDb: typeof import('@solus/server/db')['getDb']
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-restart-store-'))
  process.env.SOLUS_DATA_DIR = directory
  ;({ SessionRestartStore: Store } = await import('@solus/server/data/sessions/session-restart-store'))
  ;({ closeDb, getDb } = await import('@solus/server/db'))
})
afterEach(() => closeDb())
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})
function run(sessionId: string): RestartRun {
  return { sessionId, runId: 'original', state: 'running', author: null, authority: 'host', prompt: 'Fix the parser', backgroundTools: [],
    input: { provider: 'codex', agentSessionId: 'thread', workingDirectory: '/tmp/project', projectPath: '/tmp/project', model: 'gpt-6-astra',
      preferredModel: 'gpt-6-astra', permissionMode: 'plan', reasoningEffort: 'high', contextWindow: 1_050_000,
      fastMode: true, extraInstructions: '', forked: false, additionalDirs: [], sessionChangedFiles: [], rateLimitBehavior: 'ask', worktreeBaseBranch: null } }
}
test('recovery preserves the native conversation and options across database reopen', () => {
  const saved = run('persist')
  new Store().save(saved)
  closeDb()
  expect(new Store().get('persist')).toEqual(saved)
})
test('a durable recovery claim prevents another automatic delivery', () => {
  const saved = run('claim')
  const store = new Store()
  store.save(saved)
  expect(store.claim(saved)).toBe(true)
  closeDb()
  expect(new Store().get('claim')?.state).toBe('delivering')
  expect(new Store().claim(saved)).toBe(false)
})
test('new work and explicit stop invalidate the old receipt without deleting a newer run', () => {
  const store = new Store()
  const saved = run('newer')
  store.save(saved)
  store.save({ ...saved, runId: 'new' })
  store.remove('newer', 'original')
  expect(store.get('newer')?.runId).toBe('new')
  store.remove('newer')
  expect(store.get('newer')).toBeUndefined()
  expect(store.claim(saved)).toBe(false)
})


test('live receipt reads, repeated saves and absent removals do not execute SQL', () => {
  const store = new Store()
  const saved = run('cached')
  store.save(saved)
  const prepare = spyOn(getDb(), 'prepare')
  try {
    expect(store.get('cached')).toEqual(saved)
    expect(store.list().some((item) => item.sessionId === 'cached')).toBe(true)
    store.save(saved)
    store.remove('missing')
    store.remove('cached', 'different-run')
    expect(prepare).not.toHaveBeenCalled()
    store.save({ ...saved, state: 'background' })
    expect(prepare).toHaveBeenCalledTimes(1)
    store.remove('cached')
    store.remove('cached')
    expect(prepare).toHaveBeenCalledTimes(2)
  } finally {
    prepare.mockRestore()
  }
})

test('mutating a returned receipt cannot suppress its durable update', () => {
  const store = new Store()
  store.save(run('isolated'))
  const saved = store.get('isolated')!
  saved.backgroundTools.push({ toolId: 'tool', name: 'Bash' })
  expect(store.get('isolated')?.backgroundTools).toEqual([])
  store.save(saved)
  closeDb()
  expect(new Store().get('isolated')?.backgroundTools).toEqual([{ toolId: 'tool', name: 'Bash' }])
})
