import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { resetTestDatabase } from './helpers/test-db'
import { installTestIdentities } from './helpers/acting-identities'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { WorkspaceLink } from '@solus/contracts/solus-api'
mock.module('node:sqlite', () => ({ DatabaseSync }))

// One link route and one comment route carry an agent's remaining organization
// writes to the Solus API (docs/plans/simplify-auth-and-sync.md §4.5). A link needs
// editor on `from`, keeps both ends in one organization, and each (from, to) pair
// writes the table it has always used.

const previous = process.env.SOLUS_DATA_DIR
let dataDir: string
let operations: WorkspaceOperations
let database: typeof import('@solus/server/db/database')
let app: { request(path: string, init?: RequestInit): Promise<Response> }

const member = (userId: string, organizationId: string): WorkspaceRequestContext => ({
  principal: { kind: 'org-member', userId, organizationId, organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: userId, deviceId: `${userId}-device`, deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 },
  home: { kind: 'organization', organizationId, serviceId: 'api' },
  scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read', 'sessions:write'],
})
const alice = member('alice', 'A')
const bob = member('bob', 'A')
const carol = member('carol', 'B')
/** A host's agent acting for Alice: its credential names no session. */
const alicesAgent: WorkspaceRequestContext = { ...alice, actingAgent: { organizationId: 'A' } }

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-api-links-')); process.env.SOLUS_DATA_DIR = dataDir
  database = await import('@solus/server/db/database')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(new ShareManager({ db: database.getDatabase() }))
  const { Hono } = await import('hono')
  const { createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const admission = { socket: async () => null, bearer: async (bearer: string) => bearer === 'alice' ? alice : null }
  const router = createSolusApiRouter({ admission, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: [], events: { transport: 'socket.io', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => '{}' })
  app = new Hono().route('/v1', router)
  const { upsertSessionRecord } = await import('@solus/server/data/sessions/session-records')
  await upsertSessionRecord('A', { sessionId: 's1', provider: 'codex', projectPath: '-repo', runnerHostId: 'runner-A', lastActivityAt: Date.now() }, { organizationId: 'A', published: true, ownerKey: 'alice' })
})
afterAll(async () => { await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous })

installTestIdentities()

let keys = 0
const key = () => `solus-api-links-${String(++keys).padStart(4, '0')}`
const count = async (query: ReturnType<typeof sql>) => z.object({ n: z.number() }).parse(await database.getDatabase().get(query)).n
const call = (method: string, path: string, body: object, headers: Record<string, string> = {}) => app.request('/v1' + path, {
  method, headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
})

test('a link put twice is one row, and the route answers 204', async () => {
  const task = await operations.createTask(alice, { title: 'Twice' }, key())
  const work = await operations.createWork(alice, { title: 'Spec', type: 'doc', content: '# Spec' }, key())
  const link = { from: { kind: 'task', id: task.id }, to: { kind: 'work', id: work.id } }
  expect((await call('PUT', '/links', link)).status).toBe(204)
  expect((await call('PUT', '/links', link)).status).toBe(204)
  expect(await count(sql`SELECT COUNT(*) AS n FROM task_links WHERE task_id = ${task.id}`)).toBe(1)
  expect((await call('DELETE', '/links', link)).status).toBe(204)
  expect(await count(sql`SELECT COUNT(*) AS n FROM task_links WHERE task_id = ${task.id}`)).toBe(0)
})

test('a caller who is not an editor of `from` is refused, and nothing is written', async () => {
  const task = await operations.createTask(alice, { title: "Alice's own" }, key())
  const work = await operations.createWork(bob, { title: "Bob's doc", type: 'doc', content: '# Doc' }, key())
  await expect(operations.putLink(bob, { from: { kind: 'task', id: task.id }, to: { kind: 'work', id: work.id } })).rejects.toMatchObject({ status: 404 })
  await expect(operations.putLink(bob, { from: { kind: 'session', id: 's1' }, to: { kind: 'pr', url: 'https://github.com/acme/app/pull/1' } })).rejects.toMatchObject({ status: 404 })
  expect(await count(sql`SELECT COUNT(*) AS n FROM task_links WHERE task_id = ${task.id}`)).toBe(0)
  // A pair that is not a link is refused before anything is read.
  await expect(operations.putLink(alice, { from: { kind: 'task', id: task.id }, to: { kind: 'file', path: '/plan.md', hostId: 'runner-A' } })).rejects.toThrow('cannot link a file')
})

test('a link that crosses organizations is refused', async () => {
  const task = await operations.createTask(alice, { title: 'In A' }, key())
  const elsewhere = await operations.createWork(carol, { title: 'In B', type: 'doc', content: '# B' }, key())
  const link: WorkspaceLink = { from: { kind: 'task', id: task.id }, to: { kind: 'work', id: elsewhere.id } }
  // Alice cannot read B's work at all.
  await expect(operations.putLink(alice, link)).rejects.toMatchObject({ status: 404 })
  // Even a caller that may read both ends cannot join two organizations.
  const system: WorkspaceRequestContext = { ...alice, principal: { kind: 'system' } }
  await expect(operations.putLink(system, link)).rejects.toThrow('one organization')
  expect(await count(sql`SELECT COUNT(*) AS n FROM task_links WHERE task_id = ${task.id}`)).toBe(0)
})

test('each (from, to) pair writes its own table, and a delete by the same key removes it', async () => {
  const task = await operations.createTask(alice, { title: 'Every pair' }, key())
  const work = await operations.createWork(alice, { title: 'Doc', type: 'doc', content: '# Doc' }, key())
  const fromTask = { kind: 'task' as const, id: task.id }
  const fromSession = { kind: 'session' as const, id: 's1' }
  const taskLinks = (kind: string) => count(sql`SELECT COUNT(*) AS n FROM task_links WHERE task_id = ${task.id} AND kind = ${kind}`)
  const sessionLinks = (kind: string) => count(sql`SELECT COUNT(*) AS n FROM session_links WHERE session_id = 's1' AND link_id LIKE ${kind + ':%'}`)
  const workSessions = async () => z.object({ meta: z.string() }).parse(await database.getDatabase().get(sql`SELECT meta FROM works WHERE id = ${work.id}`)).meta
  const sessionPrs = () => count(sql`SELECT COUNT(*) AS n FROM session_pull_requests WHERE session_id = 's1' AND source <> 'dismissed'`)
  const pairs: Array<[WorkspaceLink, () => Promise<unknown>]> = [
    [{ from: fromTask, to: { kind: 'work', id: work.id } }, () => taskLinks('work')],
    [{ from: fromTask, to: { kind: 'plan', sessionId: 's1', planId: 'toolu_plan' } }, () => taskLinks('plan')],
    [{ from: fromTask, to: { kind: 'pr', url: 'https://github.com/acme/app/pull/3' } }, () => taskLinks('pr')],
    [{ from: fromTask, to: { kind: 'automation', id: 'auto-1', hostId: 'runner-A' } }, () => taskLinks('automation')],
    [{ from: fromTask, to: { kind: 'session', id: 's1' }, role: 'referenced' }, () => count(sql`SELECT COUNT(*) AS n FROM task_session_links WHERE task_id = ${task.id} AND session_id = 's1'`)],
    [{ from: fromSession, to: { kind: 'file', path: '/repo/plan.md', hostId: 'runner-A' } }, () => sessionLinks('file')],
    [{ from: fromSession, to: { kind: 'automation', id: 'auto-1', hostId: 'runner-A' } }, () => sessionLinks('automation')],
    [{ from: fromSession, to: { kind: 'pr', url: 'https://github.com/acme/app/pull/4' } }, sessionPrs],
  ]
  for (const [link, rows] of pairs) {
    await operations.putLink(alice, link)
    expect([link.to.kind, await rows()]).toEqual([link.to.kind, 1])
    await operations.deleteLink(alice, { from: link.from, to: link.to })
    expect([link.to.kind, await rows()]).toEqual([link.to.kind, 0])
  }
  // A session's work is the work's own membership.
  await operations.putLink(alice, { from: fromSession, to: { kind: 'work', id: work.id } })
  expect(JSON.parse(await workSessions()).sessionIds).toEqual(['s1'])
  await operations.deleteLink(alice, { from: fromSession, to: { kind: 'work', id: work.id } })
  expect(JSON.parse(await workSessions()).sessionIds).toEqual([])
  // A session's file is its execution host's.
  await expect(operations.putLink(alice, { from: fromSession, to: { kind: 'file', path: '/repo/plan.md', hostId: 'runner-B' } })).rejects.toThrow('execution host')
})

test("a session's pull request link keeps its title, its source, and the agent that made it; a removed one stays removed", async () => {
  const url = 'https://github.com/acme/app/pull/9'
  await operations.putLink(alicesAgent, { from: { kind: 'session', id: 's1' }, to: { kind: 'pr', url }, title: 'Fix the login' })
  const { readSessionPullRequests, linkSessionPullRequest } = await import('@solus/server/data/sessions/session-pull-requests')
  const [link] = ((await readSessionPullRequests('A', ['s1']))['s1'] ?? []).filter((candidate) => candidate.number === 9)
  expect(link).toMatchObject({ title: 'Fix the login', source: 'agent', createdBy: { kind: 'agent', sessionId: 's1', for: { id: { kind: 'account', accountId: 'alice' } } } })
  await operations.deleteLink(alice, { from: { kind: 'session', id: 's1' }, to: { kind: 'pr', url } })
  // PR sync finding it on the branch again does not bring it back.
  await linkSessionPullRequest('s1', { url, source: 'branch', by: { kind: 'system' } })
  expect(((await readSessionPullRequests('A', ['s1']))['s1'] ?? []).some((candidate) => candidate.number === 9)).toBe(false)
})

test('a comment posts as the caller, and the same key answers the same comment', async () => {
  const task = await operations.createTask(alice, { title: 'Discuss' }, key())
  const headers = { 'Idempotency-Key': 'comment-key-000000001' }
  const posted = await call('POST', `/tasks/${task.id}/comments`, { body: 'Looks right.' }, headers)
  expect(posted.status).toBe(201)
  const comment = await posted.json()
  expect(comment).toMatchObject({ taskId: task.id, body: 'Looks right.', author: { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' } } }, originSessionId: null })
  expect(await (await call('POST', `/tasks/${task.id}/comments`, { body: 'Looks right.' }, headers)).json()).toEqual(comment)
  // An agent acting for her names the session it works in.
  const byAgent = await operations.createTaskComment(alicesAgent, task.id, { body: 'Done.', originSessionId: 's1' }, key())
  expect(byAgent.author).toMatchObject({ kind: 'agent', sessionId: 's1' })
  // Bob may not edit Alice's task, so he may not comment on it.
  await expect(operations.createTaskComment(bob, task.id, { body: 'Hi' }, key())).rejects.toMatchObject({ status: 404 })
})
