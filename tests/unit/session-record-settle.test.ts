import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installTestIdentities } from './helpers/acting-identities'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
installTestIdentities()

// The git lookup of a session's repository is slow on a real machine. Here it
// waits until the test lets it answer, so the turn settles first every time.
let answerRemote: (key: string) => void = () => {}
const gitHelpers = await import('@solus/server/git/git-helpers')
mock.module('@solus/server/git/git-helpers', () => ({
  ...gitHelpers,
  resolveRepositoryKey: () => new Promise<string>((resolve) => { answerRemote = resolve }),
}))

/**
 * A turn's settled status is the record's last word: the session's start must
 * not land after it and leave the record `running`, which the runner then
 * reports to the Solus API until the next turn (Lab cloud-sessions, "[sqlite]
 * the record settled to idle").
 */

let dataDir = ''
let indexer: typeof import('@solus/server/db/session-indexer')
let lineage: typeof import('@solus/server/data/sessions/session-lineage')
let records: typeof import('@solus/server/data/sessions/session-records')
let closeDb: () => void

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-record-settle-'))
  process.env.SOLUS_DATA_DIR = dataDir
  indexer = await import('@solus/server/db/session-indexer')
  lineage = await import('@solus/server/data/sessions/session-lineage')
  records = await import('@solus/server/data/sessions/session-records')
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a turn that settles before the git lookup ends stays settled', async () => {
  const repo = join(dataDir, 'repo')
  const reported: string[] = []
  const stop = records.onSessionRecordChanged((record) => {
    if (record.sessionId === 'session-fast') reported.push(record.status)
  })
  lineage.registerSessionLineage({ sessionId: 'session-fast', provider: 'codex', providerSessionId: 'thread-fast', cwd: repo })
  indexer.persistIndexedSessionStart('thread-fast', 'codex', repo, '-repo', 'gpt-test', 'medium', 'fast turn')
  // The turn ends at once, as the runtime's status writer reports it.
  await records.setSessionRecordStatus('local', 'session-fast', 'idle')
  answerRemote('github.com/acme/fast')

  let record = await records.getSessionRecord('local', 'session-fast')
  for (let attempt = 0; attempt < 100 && !record?.projectRemote; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    record = await records.getSessionRecord('local', 'session-fast')
  }
  stop()
  expect(record?.projectRemote).toBe('github.com/acme/fast')
  expect(record?.status).toBe('idle')
  expect(record?.title).toBe('fast turn')
  // What the runner forwards to the Solus API ends with the settle too.
  expect(reported.at(-1)).toBe('idle')
})
