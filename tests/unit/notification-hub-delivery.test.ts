import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { Principal } from '@solus/server/admission/principal'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { SolusApiClient } from '@solus/contracts/solus-api/client'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/015-notifications-hub.md §5, stage 3: where notifications are written for
// organization work. A record whose home is the Solus API is changed there, and its
// producers write there once: a host that forwards the change writes no copy, and a
// redelivered request (its answer was lost) adds nothing. A host-owned result (an
// automation run) stays in the host's inbox in its organization; nothing sends it
// to the API, which has no record to check it against (plans/015 v2 §1).

let operations: WorkspaceOperations
let store: typeof import('@solus/server/data/notifications/store')
let database: typeof import('@solus/server/db/database')
let legacy: typeof import('@solus/server/db')
let remote: typeof import('@solus/server/sync/remote-operations')
let shares: import('@solus/server/sharing/share-manager').ShareManager

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-notification-delivery-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/notifications/store')
  database = await import('@solus/server/db/database')
  legacy = await import('@solus/server/db')
  remote = await import('@solus/server/sync/remote-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  shares = new ShareManager({ db: database.getDatabase() })
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

beforeEach(async () => {
  await database.getDatabase().run(sql`DELETE FROM notifications`)
})

const memberPrincipal = (userId: string): Extract<Principal, { kind: 'org-member' }> => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'cloud',
  displayName: userId, deviceId: `${userId}-device`, deviceLabel: 'Browser', expiresAt: Date.now() + 300_000,
})
const alice: WorkspaceRequestContext = {
  principal: memberPrincipal('alice'),
  home: { kind: 'organization', organizationId: 'org1', serviceId: 'api' },
  scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'],
}
const rows = async () => Number((await database.getDatabase().get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM notifications`))?.count ?? 0)

describe('organization records', () => {
  test('a host forwarding a change to the API writes no copy; a redelivered request adds nothing', async () => {
    const work = await operations.createWork(alice, { title: 'Plan', type: 'doc', content: 'body' }, 'delivery-work-0001')
    // The host's operations for an organization session only forward to the API.
    const sent: string[] = []
    // SAFETY: the forwarding operations call only `request`.
    const client = { request: async (operation: string) => { sent.push(operation); return { state: 'in_review', reviewers: [] } } } as unknown as SolusApiClient
    const forwarding = remote.remoteWorkspaceOperations(client, async () => true)
    await forwarding.requestWorkReview(alice, work.id, { reviewerIds: ['bob'], expectedContentVersion: work.contentVersion, requestId: 'req-1' })
    expect(sent).toEqual(['requestWorkReview'])
    expect(await rows()).toBe(0)

    // The API applies the request; the answer is lost and the same request is sent again.
    const request = { reviewerIds: ['bob'], expectedContentVersion: work.contentVersion, requestId: 'req-1' }
    await operations.requestWorkReview(alice, work.id, request)
    await operations.requestWorkReview(alice, work.id, request)
    const inbox = (await store.listNotifications({ scope: 'org1', recipientKey: 'bob' }, {})).items
    expect(inbox.map((row) => row.facts.kind)).toEqual(['work.review_requested'])
  })
})

describe('host-owned results', () => {
  // Automation runs live in the host's SQLite file; the hub row is written there atomically or not at all.
  test.skipIf(Boolean(process.env.DATABASE_URL))('an organization automation result stays in the host inbox, in its organization', async () => {
    legacy.withTx(() => store.recordNotificationSync(legacy.getDb(), {
      organizationId: 'org1', eventId: 'automation.finished:run-org', recipients: ['bob'],
      facts: { kind: 'automation.finished', status: 'succeeded' }, resource: { kind: 'automation', automationId: 'a1', runId: 'run-org' },
      by: { kind: 'automation', automationId: 'a1', name: 'Nightly' }, summary: { title: 'Nightly' },
    }))
    const items = (await store.listNotifications({ scope: 'org1', recipientKey: 'bob' }, {})).items
    expect(items.map((row) => [row.organizationId, row.resource.kind])).toEqual([['org1', 'automation']])
    // No other organization's reader sees it.
    expect((await store.listNotifications({ scope: 'org2', recipientKey: 'bob' }, {})).items).toEqual([])
  })
})
