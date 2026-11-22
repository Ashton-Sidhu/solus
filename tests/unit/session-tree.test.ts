import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { SessionDigest } from '@solus/contracts/session-digest'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A session tree is read from the database alone: each node's record, its
 * stored digest, and its artifacts (docs/plans/session-digests.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let directory: string
const previous = process.env.SOLUS_DATA_DIR

function digestOf(sessionId: string, prompt: string): SessionDigest {
  return {
    sessionId,
    turns: [{ id: `${sessionId}-turn`, startedAt: 1, endedAt: 2, settled: true, prompt, toolCalls: [[0, 3]], changes: { filesChanged: 1, additions: 2, deletions: 0 } }],
    changes: { files: [{ path: `${sessionId}.ts`, additions: 2, deletions: 0, status: 'A' }], filesChanged: 1, additions: 2, deletions: 0 },
    subagents: [{ id: 'agent', title: 'Audit', status: 'completed', startedAt: 1, endedAt: 2, detail: 'Fine.' }],
    lastReply: `${prompt} done.`,
    updatedAt: 2,
  }
}

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-session-tree-')))
  process.env.SOLUS_DATA_DIR = directory
  const { getDatabase } = await import('@solus/server/db/database')
  await getDatabase().run(sql`
    INSERT INTO session_records(session_id, organization_id, created_by, provider, project_path, cwd, status, parent_session_id, created_at, last_activity_at, started_at)
    VALUES
      ('lead', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', NULL, 1, 9, 1),
      ('child-b', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'lead', 3, 3, 1),
      ('child-a', 'local', 'owner', 'claude-code', ${directory}, ${directory}, 'idle', 'lead', 2, 2, 1),
      ('grandchild', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'child-a', 4, 4, 1)
  `)
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(directory, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

test('each node carries its own record, stored digest, and artifacts', async () => {
  // WHY: the parent's Threads surface shows what each child did and linked
  // from the child's own rows, with no transcript and no checkout.
  const { readSessionTree, writeSessionDigest } = await import('@solus/server/data/sessions/session-digests')
  const { linkSessionItem } = await import('@solus/server/data/sessions/session-links')
  await writeSessionDigest(digestOf('lead', 'Plan'))
  await writeSessionDigest(digestOf('child-a', 'Build'))
  await writeSessionDigest(digestOf('grandchild', 'Test'))
  await linkSessionItem('child-a', { target: { kind: 'file', path: '/tmp/plan.md', hostId: 'host-1' } }, { kind: 'system' })

  const tree = await readSessionTree('local', 'lead')
  expect(tree.nodes.map((node) => node.record.sessionId)).toEqual(['lead', 'child-a', 'child-b', 'grandchild'])
  const child = tree.nodes[1]
  expect(child.digest).toEqual(digestOf('child-a', 'Build'))
  expect(child.artifacts).toEqual([expect.objectContaining({ kind: 'file', path: '/tmp/plan.md' })])
  expect(tree.nodes[0].artifacts).toEqual([])
  // A session that did nothing yet has no digest: unknown, not empty.
  expect(tree.nodes[2].digest).toBeNull()
  // A child's tree is its own subtree.
  expect((await readSessionTree('local', 'child-a')).nodes.map((node) => node.record.sessionId)).toEqual(['child-a', 'grandchild'])
  // Another organization does not read these sessions.
  expect((await readSessionTree('organization-B', 'lead')).nodes).toEqual([])
})

test('a subtree another host runs is stored under its local parent and read with the tree', async () => {
  // WHY: a child on another host is in its parent's tree from this host's
  // database, also while that host is offline, and its pull requests are a copy
  // that starts no PR sync here.
  const { readSessionTree, storeRemoteSessionTree } = await import('@solus/server/data/sessions/session-digests')
  const remoteRecord = (sessionId: string, parentSessionId: string) => ({
    sessionId, provider: 'codex' as const, projectPath: '/remote/project', lastActivityAt: 7, createdAt: 7,
    runnerHostId: 'host-b', parentSessionId, title: `Remote ${sessionId}`, status: 'idle' as const,
  })
  const pullRequest = {
    kind: 'pull-request' as const,
    link: { sessionId: 'remote-child', repository: 'github.com/acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Fix', source: 'agent' as const, linkedAt: 7 },
  }
  await storeRemoteSessionTree('child-b', [
    { record: remoteRecord('remote-child', 'child-b'), digest: digestOf('remote-child', 'Remote work'), artifacts: [pullRequest] },
    { record: remoteRecord('remote-grandchild', 'remote-child'), digest: null, artifacts: [] },
  ])

  const tree = await readSessionTree('local', 'lead')
  expect(tree.nodes.map((node) => node.record.sessionId)).toEqual(['lead', 'child-a', 'child-b', 'grandchild', 'remote-child', 'remote-grandchild'])
  const remote = tree.nodes[4]
  expect(remote.record).toMatchObject({ runnerHostId: 'host-b', parentSessionId: 'child-b', organizationId: 'local', ownerKey: 'owner' })
  expect(remote.digest).toEqual(digestOf('remote-child', 'Remote work'))
  expect(remote.artifacts).toEqual([pullRequest])
  const { getDatabase } = await import('@solus/server/db/database')
  expect(await getDatabase().all(sql`SELECT source_id FROM resource_links WHERE source_id = 'remote-child'`)).toEqual([])
  // A parent this host does not have stores nothing.
  await storeRemoteSessionTree('not-here', [{ record: remoteRecord('orphan', 'not-here'), digest: null, artifacts: [] }])
  expect(await getDatabase().all(sql`SELECT session_id FROM session_records WHERE session_id = 'orphan'`)).toEqual([])
})

test('a new digest replaces the stored one, and a session delete removes it', async () => {
  const { readSessionDigests, writeSessionDigest } = await import('@solus/server/data/sessions/session-digests')
  const { deleteSessionRecord } = await import('@solus/server/data/sessions/session-records')
  await writeSessionDigest({ ...digestOf('grandchild', 'Test again'), updatedAt: 5 })
  expect((await readSessionDigests('local', ['grandchild'])).get('grandchild')?.lastReply).toBe('Test again done.')
  await deleteSessionRecord('local', 'grandchild')
  expect((await readSessionDigests('local', ['grandchild'])).has('grandchild')).toBe(false)
})
