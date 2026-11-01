import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { resetTestDatabase } from './helpers/test-db'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { sessionLinkInputSchema } from '@solus/contracts/session-links'

mock.module('node:sqlite', () => ({ DatabaseSync }))
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
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  expect((await linkAgentTool.execute({ kind: 'file', path: 'plan.md' }, tools)).ok).toBe(true)
  expect((await linkAgentTool.execute({ kind: 'file', path: './plan.md' }, tools)).ok).toBe(true)
  const links = (await storedLinks('session-1')).filter(link => link.target.kind === 'file')
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({ target: { kind: 'file', path, hostId: 'host-1' }, title: 'plan.md', organization_id: 'local' })
  expect(links[0].link_id.length).toBeLessThan(100)
})

test('works use their existing session membership; a repeated link changes nothing', async () => {
  const work = await operations.createWork(context, { title: 'Linked work', type: 'doc', content: 'Retained' }, 'session-links-work-1')
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
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
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  expect((await linkAgentTool.execute({ kind: 'automation', target_id: automation.id }, tools)).ok).toBe(true)
  expect((await linkAgentTool.execute({ kind: 'automation', target_id: automation.id }, tools)).ok).toBe(true)
  const links = (await storedLinks('session-1')).filter(link => link.target.kind === 'automation')
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({ target: { kind: 'automation', targetId: automation.id, hostId: 'host-1' }, title: 'Linked schedule' })
  expect((await loadAutomation(automation.id))?.enabled).toBe(false)
})

test('invalid files and task destinations do not write references', async () => {
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  const before = await storedLinks('session-1')
  expect((await linkAgentTool.execute({ kind: 'file', path: directory }, tools)).ok).toBe(false)
  expect((await linkAgentTool.execute({ kind: 'file', path: 'missing.md' }, tools)).ok).toBe(false)
  expect((await linkAgentTool.execute({ kind: 'file', path: 'plan.md', task_id: 'task' }, tools)).ok).toBe(false)
  expect(await storedLinks('session-1')).toEqual(before)
})

test('a caller cannot link items to a session it cannot edit', async () => {
  const { withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority')
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  const principal = { kind: 'org-member' as const, userId: 'bob', organizationId: 'organization-A', organizationRole: 'member' as const, teamIds: [], hostKind: 'personal' as const, displayName: 'Bob', deviceId: 'bob-device', deviceLabel: 'Test', expiresAt: Date.now() + 300000 }
  const result = await withWorkspaceToolAuthority(principal, () => linkAgentTool.execute({ kind: 'file', path: 'plan.md' }, tools))
  expect(result.ok).toBe(false)
})

test("the link route stores a session's file reference once, on its execution host, and removes it", async () => {
  const { getDatabase } = await import('@solus/server/db/database')
  await getDatabase().run(sql`INSERT INTO session_records(session_id, organization_id, owner_key, provider, project_path, runner_host_id, status, created_at, last_activity_at) VALUES ('remote-session', 'organization-A', 'alice', 'codex', '/runner/project', 'runner-A', 'idle', 1, 2)`)
  const inA: WorkspaceRequestContext = { ...context, home: { kind: 'organization', organizationId: 'organization-A', serviceId: 'api' } }
  const link = { from: { kind: 'session' as const, id: 'remote-session' }, to: { kind: 'file' as const, path: 'C:\\runner\\plan.md', hostId: 'runner-A' }, title: 'Runner plan' }
  await operations.putLink(inA, link)
  await operations.putLink(inA, link)
  expect(await storedLinks('remote-session')).toEqual([expect.objectContaining({ organization_id: 'organization-A', title: 'Runner plan', target: { kind: 'file', path: 'C:\\runner\\plan.md', hostId: 'runner-A' } })])
  // A file is its session's execution host's; another organization does not hold the session.
  await expect(operations.putLink(inA, { ...link, to: { ...link.to, hostId: 'runner-B' } })).rejects.toThrow('execution host')
  await expect(operations.putLink({ ...context, home: { kind: 'organization', organizationId: 'organization-B', serviceId: 'api' } }, link)).rejects.toThrow('not found')
  await operations.deleteLink(inA, { from: link.from, to: link.to })
  expect(await storedLinks('remote-session')).toEqual([])
})

test('work membership cannot cross organization boundaries', async () => {
  const { linkSessionItem } = await import('@solus/server/data/sessions/session-links')
  const work = await operations.createWork(context, { title: 'Local work', type: 'doc', content: 'Private' }, 'session-links-local-work')
  await expect(linkSessionItem('remote-session', { target: { kind: 'work', targetId: work.id } }, actor)).rejects.toThrow('organization')
})


test('list_links includes all link types, filters by kind, and unlink keeps the targets', async () => {
  const { linkAgentTool, listLinksAgentTool, unlinkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  const { createAutomation, loadAutomation } = await import('@solus/server/data/automations/automations-store')
  const { linkSessionPullRequest } = await import('@solus/server/data/sessions/session-pull-requests')
  const work = await operations.createWork(context, { title: 'Keep this document', type: 'doc', content: 'Keep content' }, 'generic-link-work')
  const automation = await createAutomation('Keep this automation', { prompt: 'Later', cwd: directory, agentProvider: 'codex', modelId: null, reasoningEffort: 'medium' }, actor, false)
  const path = join(directory, 'removed-file.png')
  const url = 'https://github.com/acme/solus/pull/42'
  writeFileSync(path, 'fixture')
  const inputs = [
    { kind: 'work', target_id: work.id },
    { kind: 'automation', target_id: automation.id },
    { kind: 'file', path },
    { kind: 'pr', target_id: url },
  ]
  for (const input of inputs) expect((await linkAgentTool.execute(input, tools)).ok).toBe(true)
  const listed = await listLinksAgentTool.execute({}, tools)
  expect(listed.ok).toBe(true)
  for (const identifier of [work.id, automation.id, path, url]) expect(listed.text).toContain(identifier)
  const prs = await listLinksAgentTool.execute({ kind: 'pr' }, tools)
  expect(prs.text).toContain(url)
  expect(prs.text).not.toContain(work.id)
  expect(prs.text).not.toContain(path)
  rmSync(path)
  for (const input of inputs) {
    expect((await unlinkAgentTool.execute(input, tools)).ok).toBe(true)
    expect((await unlinkAgentTool.execute(input, tools)).ok).toBe(true)
  }
  const after = await listLinksAgentTool.execute({}, tools)
  for (const identifier of [work.id, automation.id, path, url]) expect(after.text).not.toContain(identifier)
  expect((await operations.getWork(context, work.id)).content).toBe('Keep content')
  expect((await loadAutomation(automation.id))?.enabled).toBe(false)
  // Automatic PR discovery must respect the removal; explicit link restores it.
  expect(await linkSessionPullRequest('session-1', { url, source: 'branch', by: actor })).toBe(false)
  expect((await linkAgentTool.execute({ kind: 'pr', target_id: url }, tools)).ok).toBe(true)
  expect((await listLinksAgentTool.execute({ kind: 'pr' }, tools)).text).toContain(url)
})

test('unlink and list_links reject invalid inputs and unauthorized sessions', async () => {
  const { unlinkAgentTool, listLinksAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  const { withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority')
  for (const input of [{ kind: 'work' }, { kind: 'file' }, { kind: 'session', target_id: 'session-1' }]) {
    expect((await unlinkAgentTool.execute(input, tools)).ok).toBe(false)
  }
  expect((await listLinksAgentTool.execute({ kind: 'session' }, tools)).ok).toBe(false)
  const principal = { kind: 'org-member' as const, userId: 'bob', organizationId: 'organization-A', organizationRole: 'member' as const, teamIds: [], hostKind: 'personal' as const, displayName: 'Bob', deviceId: 'bob-device', deviceLabel: 'Test', expiresAt: Date.now() + 300000 }
  const before = await storedLinks('session-1')
  expect((await withWorkspaceToolAuthority(principal, () => unlinkAgentTool.execute({ kind: 'file', path: 'plan.md' }, tools))).ok).toBe(false)
  expect((await withWorkspaceToolAuthority(principal, () => listLinksAgentTool.execute({}, tools))).ok).toBe(false)
  expect(await storedLinks('session-1')).toEqual(before)
})

async function batchSession(sessionId: string): Promise<AgentToolContext> {
  const { getDatabase } = await import('@solus/server/db/database')
  await getDatabase().run(sql`INSERT INTO session_records(session_id, organization_id, owner_key, provider, project_path, cwd, status, created_at, last_activity_at) VALUES (${sessionId}, 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 1, 2)`)
  return { ...tools, sessionId: () => sessionId }
}

async function linkedNumbers(sessionId: string): Promise<string[]> {
  const { readSessionPullRequests } = await import('@solus/server/data/sessions/session-pull-requests')
  const links = (await readSessionPullRequests('local', [sessionId]))[sessionId] ?? []
  return links.map(link => `${link.repository}#${link.number}`).sort()
}

// WHY: agents link a whole stack, or a pasted list, of pull requests. One call
// must link them all, tell apart what was new, already linked, or not a pull
// request, and one bad name must not lose the others.
test('link with target_ids links new pull requests once, reports already linked ones, and survives invalid names', async () => {
  const batchTools = await batchSession('session-batch-link')
  const { linkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  expect((await linkAgentTool.execute({ kind: 'pr', target_id: 'https://github.com/acme/app/pull/1' }, batchTools)).ok).toBe(true)
  const result = await linkAgentTool.execute({ kind: 'pr', target_ids: [
    'https://github.com/acme/app/pull/1',
    'https://github.com/acme/app/pull/2',
    'https://github.com/acme/app/pull/3',
    'https://github.com/acme/web/pull/9',
    'https://github.com/acme/app/pull/2',
    'https://example.com/not-a-pull-request',
  ] }, batchTools)
  expect(result.ok).toBe(true)
  expect(result.text).toContain('Linked 3 pull requests')
  expect(result.text).toContain('linked: github.com/acme/app #2, #3; github.com/acme/web #9')
  expect(result.text).toContain('already linked: github.com/acme/app #1, #2')
  expect(result.text).toContain('invalid (not a pull request number or URL): "https://example.com/not-a-pull-request"')
  expect(await linkedNumbers('session-batch-link')).toEqual(['github.com/acme/app#1', 'github.com/acme/app#2', 'github.com/acme/app#3', 'github.com/acme/web#9'])
  // Only invalid names link nothing, and the call says so.
  expect((await linkAgentTool.execute({ kind: 'pr', target_ids: ['nope'] }, batchTools)).ok).toBe(false)
  // target_ids is for pull requests, and is not mixed with target_id.
  expect((await linkAgentTool.execute({ kind: 'work', target_ids: ['work-1'] }, batchTools)).ok).toBe(false)
  expect((await linkAgentTool.execute({ kind: 'pr', target_id: 'https://github.com/acme/app/pull/4', target_ids: ['https://github.com/acme/app/pull/5'] }, batchTools)).ok).toBe(false)
  expect(await linkedNumbers('session-batch-link')).toHaveLength(4)
})

// WHY: "unlink every merged PR" must remove only the pull requests PR sync saw
// in those states. A closed one stays when only merged was asked for, and a
// link with no synced state is never guessed at.
test('unlink with states removes only the links whose last synced state matches', async () => {
  const batchTools = await batchSession('session-batch-unlink')
  const { linkAgentTool, unlinkAgentTool } = await import('@solus/server/execution/agents/tools/session-link-tools')
  const { recordSessionPullRequestObservation } = await import('@solus/server/data/sessions/session-pull-requests')
  const urls = [1, 2, 3, 4, 5].map(number => `https://github.com/acme/stack/pull/${number}`)
  expect((await linkAgentTool.execute({ kind: 'pr', target_ids: [...urls, 'https://github.com/acme/other/pull/7'] }, batchTools)).ok).toBe(true)
  const observed = (state: 'open' | 'closed' | 'merged') => ({ title: 'PR', state, draft: false, updatedAt: '2026-10-30T10:00:00Z' }) as never
  await recordSessionPullRequestObservation('github.com/acme/stack', 1, observed('merged'))
  await recordSessionPullRequestObservation('github.com/acme/other', 7, observed('merged'))
  await recordSessionPullRequestObservation('github.com/acme/stack', 2, observed('closed'))
  await recordSessionPullRequestObservation('github.com/acme/stack', 3, observed('open'))
  await recordSessionPullRequestObservation('github.com/acme/stack', 4, null)
  // stack #5 has no synced state.

  const merged = await unlinkAgentTool.execute({ kind: 'pr', states: ['merged'] }, batchTools)
  expect(merged.ok).toBe(true)
  expect(merged.text).toContain('Removed 2 pull requests in state merged')
  expect(merged.text).toMatch(/^merged: .*github\.com\/acme\/stack #1/m)
  expect(merged.text).toMatch(/^merged: .*github\.com\/acme\/other #7/m)
  expect(merged.text).toContain('4 pull requests stay linked, 2 with no synced state.')
  expect(await linkedNumbers('session-batch-unlink')).toEqual(['github.com/acme/stack#2', 'github.com/acme/stack#3', 'github.com/acme/stack#4', 'github.com/acme/stack#5'])

  const ended = await unlinkAgentTool.execute({ kind: 'pr', states: ['closed', 'merged'] }, batchTools)
  expect(ended.text).toContain('Removed 1 pull request in state closed or merged')
  expect(ended.text).toContain('closed: github.com/acme/stack #2')
  expect(await linkedNumbers('session-batch-unlink')).toEqual(['github.com/acme/stack#3', 'github.com/acme/stack#4', 'github.com/acme/stack#5'])
  // A removed link is a tombstone, so PR sync does not link it again.
  const { linkSessionPullRequest } = await import('@solus/server/data/sessions/session-pull-requests')
  expect(await linkSessionPullRequest('session-batch-unlink', { url: urls[0], source: 'branch', by: actor })).toBe(false)
  // states is for pull requests, and is not mixed with target_id.
  expect((await unlinkAgentTool.execute({ kind: 'work', states: ['open'] }, batchTools)).ok).toBe(false)
  expect((await unlinkAgentTool.execute({ kind: 'pr', target_id: urls[2], states: ['open'] }, batchTools)).ok).toBe(false)
  expect(await linkedNumbers('session-batch-unlink')).toHaveLength(3)
})
