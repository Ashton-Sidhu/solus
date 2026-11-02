import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { encodePathAsFolder, type NormalizedEvent } from '@solus/contracts/types'

// bun has no node:sqlite; the indexer's import chain reaches it.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// A client that reconnects drops the live statuses it heard and reads the
// session list again. A non-blocking question asked while it was away must be
// in that read, or the row shows "Working" or "Ready" while the agent waits.

let dataDir: string
let closeDb: () => void

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pending-question-record-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a list read carries a waiting non-blocking question until it is answered', async () => {
  const indexer = await import('@solus/server/db/session-indexer')
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  const questions = await import('@solus/server/data/sessions/async-questions')

  const cwd = '/Users/me/projects/solus'
  for (const id of ['asking', 'quiet']) {
    indexer.persistIndexedSessionStart(id, 'codex', cwd, encodePathAsFolder(cwd), 'gpt-5.5', 'high', 'hello')
  }
  for (const id of ['asking', 'quiet']) {
    for (let attempt = 0; attempt < 50 && !(await getSessionRecord(ANY_ORGANIZATION, id)); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  const context = {
    principal: { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Mac' },
    home: { kind: 'local' as const, hostId: 'this-mac' },
    scopes: ['sessions:read' as const],
  }
  const pendingIn = async () => Object.fromEntries((await operations.list(context, { limit: 50, scope: 'list' })).items.map((item) => [item.id, item.hasPendingQuestion]))

  const question: Extract<NormalizedEvent, { type: 'question_request' }> = {
    type: 'question_request', questionId: 'codex-async:thread-asking:q1', responseMode: 'message',
    questions: [{ id: '0', question: 'Which package?', options: [], multiSelect: false }],
  }
  questions.saveAsyncQuestion('asking', 'thread-asking', question)
  expect(await pendingIn()).toEqual({ asking: true, quiet: undefined })

  // Answered: the next read no longer asks for the person.
  expect(questions.claimAsyncQuestion('asking', question.questionId)).not.toBeNull()
  questions.settleAsyncQuestion(question.questionId, 'answered')
  expect(await pendingIn()).toEqual({ asking: undefined, quiet: undefined })
})
