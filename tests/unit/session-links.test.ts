import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { resetTestDatabase } from './helpers/test-db'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import { sessionLinkInputSchema } from '@solus/contracts/session-links'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let directory: string
let operations: WorkspaceOperations
let stopTools: () => void
const previous = process.env.SOLUS_DATA_DIR
const context: WorkspaceRequestContext = {
  principal: { kind: 'system' }, home: { kind: 'local', hostId: 'host-1' },
  scopes: ['works:read', 'works:write', 'sessions:read', 'sessions:write'],
}
const tools: AgentToolContext = { provider: 'codex', cwd: '', sessionId: () => 'session-1', abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} }
const actor = { kind: 'system' as const }

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-session-links-')))
  process.env.SOLUS_DATA_DIR = directory
  tools.cwd = directory
  const { getDatabase } = await import('@solus/server/db/database')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(new ShareManager({ db: getDatabase() }))
  const { installWorkspaceToolOperations } = await import('@solus/server/data/workspace/tool-context')
  stopTools = installWorkspaceToolOperations(operations, 'host-1')
  await getDatabase().run(sql`INSERT INTO session_records(session_id, organization_id, owner_key, provider, project_path, cwd, status, created_at, last_activity_at) VALUES ('session-1', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 1, 2)`)
})
afterAll(async () => {
  stopTools()
  await resetTestDatabase()
  rmSync(directory, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

async function storedLinks(sessionId: string) {
  const { getDatabase } = await import('@solus/server/db/database')
  const rows = z.array(z.object({ link_id: z.string(), target: z.string(), title: z.string(), organization_id: z.string(), linked_at: z.number() })).parse(
    await getDatabase().all(sql`SELECT link_id, target, title, organization_id, linked_at FROM session_links WHERE session_id = ${sessionId}`),
  )
  return rows.map(row => ({ ...row, target: sessionLinkInputSchema.shape.target.parse(JSON.parse(row.target)) }))
}

test('the existing link tool stores a project plan as a host file and resolves equivalent relative paths once', async () => {
  const path = join(directory, 'plan.md')
  writeFileSync(path, '# Project plan')
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/task-tools')
  expect((await linkAgentTool.execute({ kind: 'file', path: 'plan.md' }, tools)).ok).toBe(true)
  expect((await linkAgentTool.execute({ kind: 'file', path: './plan.md' }, tools)).ok).toBe(true)
  const links = (await storedLinks('session-1')).filter(link => link.target.kind === 'file')
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({ target: { kind: 'file', path, hostId: 'host-1' }, title: 'plan.md', organization_id: 'local' })
  expect(links[0].link_id.length).toBeLessThan(100)
})

test('works use their existing session membership; a repeated link changes nothing', async () => {
  const work = await operations.createWork(context, { title: 'Linked work', type: 'doc', content: 'Retained' }, 'session-links-work-1')
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/task-tools')
  expect((await linkAgentTool.execute({ kind: 'work', target_id: work.id }, tools)).ok).toBe(true)
  const first = await operations.getWork(context, work.id)
  expect(first.sessionIds).toEqual(['session-1'])
  expect((await linkAgentTool.execute({ kind: 'work', target_id: work.id }, tools)).ok).toBe(true)
  const repeated = await operations.getWork(context, work.id)
  expect(repeated.sessionIds).toEqual(['session-1'])
  expect(repeated.version).toBe(first.version)
  expect(repeated.content).toBe('Retained')
  expect((await storedLinks('session-1')).some(link => link.target.kind === 'work')).toBe(false)
})

test('automation links retain their host and do not enable or run the automation', async () => {
  const { createAutomation, loadAutomation } = await import('@solus/server/data/automations/automations-store')
  const automation = await createAutomation('Linked schedule', { prompt: 'Check later', cwd: directory, agentProvider: 'codex', modelId: null, reasoningEffort: 'medium' }, actor, false)
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/task-tools')
  expect((await linkAgentTool.execute({ kind: 'automation', target_id: automation.id }, tools)).ok).toBe(true)
  expect((await linkAgentTool.execute({ kind: 'automation', target_id: automation.id }, tools)).ok).toBe(true)
  const links = (await storedLinks('session-1')).filter(link => link.target.kind === 'automation')
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({ target: { kind: 'automation', targetId: automation.id, hostId: 'host-1' }, title: 'Linked schedule' })
  expect((await loadAutomation(automation.id))?.enabled).toBe(false)
})

test('invalid files and task destinations do not write references', async () => {
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/task-tools')
  const before = await storedLinks('session-1')
  expect((await linkAgentTool.execute({ kind: 'file', path: directory }, tools)).ok).toBe(false)
  expect((await linkAgentTool.execute({ kind: 'file', path: 'missing.md' }, tools)).ok).toBe(false)
  expect((await linkAgentTool.execute({ kind: 'file', path: 'plan.md', task_id: 'task' }, tools)).ok).toBe(false)
  expect(await storedLinks('session-1')).toEqual(before)
})

test('a caller cannot link items to a session it cannot edit', async () => {
  const { withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority')
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/task-tools')
  const principal = { kind: 'org-member' as const, userId: 'bob', organizationId: 'organization-A', organizationRole: 'member' as const, teamIds: [], hostKind: 'personal' as const, displayName: 'Bob', deviceId: 'bob-device', deviceLabel: 'Test', expiresAt: Date.now() + 300000 }
  const result = await withWorkspaceToolAuthority(principal, () => linkAgentTool.execute({ kind: 'file', path: 'plan.md' }, tools))
  expect(result.ok).toBe(false)
})

test('the existing session outbox delivers file references once and rejects another organization', async () => {
  const { getDatabase } = await import('@solus/server/db/database')
  await getDatabase().run(sql`INSERT INTO session_records(session_id, organization_id, owner_key, provider, project_path, runner_host_id, status, created_at, last_activity_at) VALUES ('remote-session', 'organization-A', 'alice', 'codex', '/runner/project', 'runner-A', 'idle', 1, 2)`)
  const { registerSessionOutboxApplier } = await import('@solus/server/data/sessions/session-applier')
  const { applyOutboxOp } = await import('@solus/server/sync/outbox/outbox-store')
  registerSessionOutboxApplier()
  const op: OutboxOp = { id: 'session-file-link-1', domain: 'sessions', resourceId: 'remote-session', name: 'link-item', sessionId: 'remote-session', recordedAt: 1,
    payload: { target: { kind: 'file', path: 'C:\\runner\\plan.md', hostId: 'runner-A' }, title: 'Runner plan', actor } }
  await applyOutboxOp(op, { organizationId: 'organization-A', ownerKey: 'alice' })
  await applyOutboxOp({ ...op, id: 'session-file-link-repeat' }, { organizationId: 'organization-A', ownerKey: 'alice' })
  expect(await storedLinks('remote-session')).toEqual([expect.objectContaining({ organization_id: 'organization-A', title: 'Runner plan', target: { kind: 'file', path: 'C:\\runner\\plan.md', hostId: 'runner-A' } })])
  await expect(applyOutboxOp({ ...op, id: 'session-file-wrong-organization' }, { organizationId: 'organization-B', ownerKey: 'bob' })).rejects.toThrow('does not belong')
})

test('work membership cannot cross organization boundaries', async () => {
  const { linkSessionItem } = await import('@solus/server/data/sessions/session-links')
  const work = await operations.createWork(context, { title: 'Local work', type: 'doc', content: 'Private' }, 'session-links-local-work')
  await expect(linkSessionItem('remote-session', { target: { kind: 'work', targetId: work.id } }, actor)).rejects.toThrow('organization')
})
