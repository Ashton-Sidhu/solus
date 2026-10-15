import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { encodePathAsFolder } from '@solus/contracts/types'

// bun has no node:sqlite; the indexer's import chain reaches it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// Mobile lists the chats of a host in one place (docs/plans/projectless-chat.md).
// Each chat has its own folder, so "the chats" is a filter on the folder's name,
// answered by the host, not every session paged to the phone and sorted there.

let dataDir: string
let closeDb: () => void

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-chat-list-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

test('the chats filter lists every chat on the host and no project session', async () => {
  const indexer = await import('@solus/server/db/session-indexer')
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')

  const sessions = [
    { id: 'chat-owner', cwd: '/Users/me/.solus/solus-chats/chat-owner' },
    { id: 'chat-member', cwd: '/data/projects/ada-1/solus-chats/chat-member' },
    { id: 'project', cwd: '/Users/me/projects/solus' },
    // A project whose name only contains the chat root's name is not a chat.
    { id: 'look-alike', cwd: '/Users/me/projects/my-solus-chats' },
  ]
  for (const session of sessions) {
    indexer.persistIndexedSessionStart(session.id, 'codex', session.cwd, encodePathAsFolder(session.cwd), 'gpt-5.5', 'high', 'hello')
  }
  for (const session of sessions) {
    for (let attempt = 0; attempt < 50 && !(await getSessionRecord(ANY_ORGANIZATION, session.id)); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  const context = {
    principal: { kind: 'local-owner' as const, deviceId: null, deviceLabel: 'Mac' },
    home: { kind: 'local' as const, hostId: 'this-mac' },
    scopes: ['sessions:read' as const],
  }
  const chats = await operations.list(context, { limit: 50, chats: 'true' })
  expect(chats.items.map((item) => item.id).sort()).toEqual(['chat-member', 'chat-owner'])
  const all = await operations.list(context, { limit: 50 })
  expect(all.items).toHaveLength(4)
})
