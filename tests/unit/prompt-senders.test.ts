import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { PromptSender } from '@solus/contracts/types'
import type { Attribution, User } from '@solus/contracts/user'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * docs/plans/prompt-sender.md: a prompt another agent or an automation sent
 * folds to one line on every client, after a reload too. The provider's
 * transcript keeps only the text, so the host keeps the sender and a history
 * read puts it back on the row the prompt became — and never on a person's.
 * A person's prompt keeps its author the same way, so a session that two
 * people drive still says who sent each prompt after a reload.
 */

let dataDir: string
let activity: typeof import('@solus/server/data/activity/activity')
let senders: typeof import('@solus/server/data/activity/prompt-senders')
let closeDb: () => void
let closeDatabase: () => Promise<void>

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-prompt-senders-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
  ;({ closeDatabase } = await import('@solus/server/db/database'))
  activity = await import('@solus/server/data/activity/activity')
  senders = await import('@solus/server/data/activity/prompt-senders')
})

afterAll(async () => {
  await closeDatabase()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const lead: PromptSender = { kind: 'agent', sessionId: 'lead', provider: 'claude-code', title: 'Plan the release' }
const nightly: PromptSender = { kind: 'automation', automationId: 'nightly', name: 'Nightly triage' }
const bob: User = { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' }
const joe: User = { id: { kind: 'account', accountId: 'joe' }, displayName: 'Joe' }
const MINUTE = 60_000

function user(content: string, timestamp: number): SessionLoadMessage {
  return { role: 'user', content, timestamp }
}

/** A sender the host kept at `at`, as `recordPromptSender` keeps it. */
async function sent(sessionId: string, sender: Attribution, text: string, at: number): Promise<void> {
  const { appendActivity, newActivity } = activity
  await appendActivity('local', newActivity({ kind: 'session', id: sessionId }, sender, { kind: 'prompt_sent', promptHash: senders.promptHash(text) }, at))
}

describe('prompt senders', () => {
  test('a reload puts the sender back on the row its prompt became, and leaves a person\'s prompts alone', async () => {
    const base = 1_000_000_000
    await sent('s1', lead, 'Reply with the single word: ready.', base)
    await sent('s1', nightly, 'Triage the new issues.\n\nLabel each one.', base + 30 * MINUTE)
    const rows = [
      user('Fix the flaky test', base - 5 * MINUTE),
      // The provider writes its row a moment after the host sends.
      user('Reply with the single word: ready.', base + 40),
      { role: 'assistant', content: 'ready', timestamp: base + 900 },
      user('Triage the new issues.\n\nLabel each one.', base + 30 * MINUTE + 25),
    ]
    const stamped = await senders.withPromptSenders('local', 's1', rows)
    expect(stamped.map((row) => row.sender)).toEqual([undefined, lead, undefined, nightly])
  })

  test('a person who types what an agent sent keeps their own prompt', async () => {
    const base = 2_000_000_000
    await sent('s2', lead, 'continue', base)
    const rows = [user('continue', base + 50), user('continue', base + 3 * MINUTE)]
    await senders.withPromptSenders('local', 's2', rows)
    expect(rows.map((row) => row.sender)).toEqual([lead, undefined])
  })

  test('a prompt whose provider row is long gone or elsewhere names no row', async () => {
    const base = 3_000_000_000
    // Its row never came (the run failed to start); a later prompt with the same text is a person's.
    await sent('s3', lead, 'Run the suite', base)
    const rows = [user('Run the suite', base + 2 * 60 * MINUTE)]
    await senders.withPromptSenders('local', 's3', rows)
    expect(rows[0]!.sender).toBeUndefined()
    // Another session's sender never reaches this one.
    const other = [user('Reply with the single word: ready.', 1_000_000_040)]
    await senders.withPromptSenders('local', 's3', other)
    expect(other[0]!.sender).toBeUndefined()
  })

  test('a Codex steer dated from its turn\'s start still finds its sender', async () => {
    const turnStart = 4_000_000_000
    await sent('s4', lead, 'Also update the docs', turnStart + 4 * MINUTE)
    const rows = [user('Start the refactor', turnStart), user('Also update the docs', turnStart)]
    await senders.withPromptSenders('local', 's4', rows)
    expect(rows.map((row) => row.sender)).toEqual([undefined, lead])
  })

  test('the record is never a history row of its own', async () => {
    const base = 5_000_000_000
    await senders.recordPromptSender('local', 's5', lead, 'Go')
    const kept = await activity.activityFor('local', { kind: 'session', id: 's5' })
    expect(kept).toHaveLength(1)
    expect(kept[0]!.by).toEqual(lead)
    const merged = activity.mergeSessionActivity([{ role: 'user', content: 'Go', timestamp: base }], kept)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.activity).toBeUndefined()
  })

  test('a reload names the person who sent each prompt of a session that two people drive', async () => {
    const base = 6_000_000_000
    await sent('s6', { kind: 'user', user: bob }, 'Add the endpoint', base)
    await sent('s6', { kind: 'user', user: joe }, 'Now write its tests', base + 5 * MINUTE)
    const rows = [
      // Sent before the host kept authors: it names nobody, as before.
      user('Start here', base - 30 * MINUTE),
      user('Add the endpoint', base + 40),
      { role: 'assistant', content: 'Done.', timestamp: base + 900 },
      user('Now write its tests', base + 5 * MINUTE + 40),
    ]
    await senders.withPromptSenders('local', 's6', rows)
    expect(rows.map((row) => row.author)).toEqual([undefined, bob, undefined, joe])
    // A person is an author, never a sender: a sender folds the prompt to one line.
    expect(rows.map((row) => row.sender)).toEqual([undefined, undefined, undefined, undefined])
  })

  test('two people who send the same words each keep their own prompt', async () => {
    const base = 7_000_000_000
    await sent('s7', { kind: 'user', user: bob }, 'continue', base)
    await sent('s7', { kind: 'user', user: joe }, 'continue', base + MINUTE)
    await sent('s7', lead, 'continue', base + 2 * MINUTE)
    const rows = [user('continue', base + 50), user('continue', base + MINUTE + 50), user('continue', base + 2 * MINUTE + 50)]
    await senders.withPromptSenders('local', 's7', rows)
    expect(rows.map((row) => row.author)).toEqual([bob, joe, undefined])
    expect(rows.map((row) => row.sender)).toEqual([undefined, undefined, lead])
  })

  test('a prompt with attached files finds its author from the words the person typed', async () => {
    // The host keeps the hash of the typed text; the provider row has the attached-file lines before it.
    await senders.recordPromptSender('local', 's8', { kind: 'user', user: joe }, 'What does this log say?')
    const [record] = await activity.activityFor('local', { kind: 'session', id: 's8' }, { kind: 'prompt_sent' })
    const rows = [user('[Attached file: /tmp/build.log]\n\nWhat does this log say?', record!.at + 40)]
    await senders.withPromptSenders('local', 's8', rows)
    expect(rows[0]!.author).toEqual(joe)
  })
})
