import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import type { SessionMeta } from '@solus/contracts/types'
import type { Task, TaskSessionLink } from '@solus/contracts/task-types'
import { SvelteRunes } from './helpers/svelte-runes'

// WHY: opening a task is opening its lead conversation with the task page
// beside it. The page must not wait for the lead's transcript, and a task the
// reader clicked past must not take the screen back when its slow reads land.

const workspaceUi = '../../packages/workspace-ui/src'
const focusRequests: unknown[] = []
const metaReads = new Map<string, (meta: SessionMeta | null) => void>()

mock.module('@solus/client-core/session-meta', () => ({
  readSessionMeta: (_serverId: string, sessionId: string) =>
    new Promise<SessionMeta | null>((resolve) => metaReads.set(sessionId, resolve)),
}))
mock.module(`${workspaceUi}/lib/inputFocus`, () => ({
  requestInputFocus: (request?: unknown) => focusRequests.push(request ?? null),
}))
mock.module(`${workspaceUi}/contexts/hosts/hosts.svelte`, () => ({
  hosts: { hasExecution: () => true, hasCollaboration: () => true, find: () => null, rolesFor: () => ['collaboration', 'execution'] },
}))
mock.module(`${workspaceUi}/contexts/connections/servers.store.svelte`, () => ({ serversStore: { executionServers: [] } }))
mock.module(`${workspaceUi}/contexts/projects/projects.store.svelte`, () => ({
  projectsStore: { projectKeyFor: (_serverId: string, key: string) => key, checkoutsOf: () => [] },
}))
mock.module(`${workspaceUi}/components/review/review-guide.store.svelte`, () => ({
  reviewGuideStore: {}, sessionGuideIdentity: () => null,
}))
mock.module(`${workspaceUi}/lib/toasts`, () => ({ toasts: {} }))
mock.module(`${workspaceUi}/lib/analytics`, () => ({ track: () => {} }))
mock.module(`${workspaceUi}/contexts/workspace/session-draft.svelte`, () => ({ ownedTaskId: () => null }))

const { SessionOpening } = await import(`${workspaceUi}/contexts/workspace/session-opening`)

function leadLink(sessionId: string): TaskSessionLink {
  return { sessionId, role: 'lead', sessionTitle: null, provider: 'codex', model: null, startedAt: null, lastActivityAt: null, linkedAt: 1 } as TaskSessionLink
}

function taskRecord(id: string): Task {
  return { id, providerId: 'local', title: id, body: '', status: 'in_progress', url: null, labels: [], updatedAt: 0 }
}

interface Resume {
  meta: SessionMeta
  opts: { stillWanted?: () => boolean; onShown?: (tabId: string) => void }
  finish: () => void
}

function harness(openLeads: Record<string, string> = {}) {
  const pages: string[] = []
  const selectedTabs: string[] = []
  const resumes: Resume[] = []
  const workspace = {
    hasCompanionPanes: true,
    tabs: Object.fromEntries(Object.entries(openLeads).map(([sessionId, tabId]) => [tabId, { id: tabId, sessionId }])),
    sessions: { byId: Object.fromEntries(Object.entries(openLeads).map(([sessionId]) => [sessionId, { id: sessionId, agentSessionId: sessionId, run: { serverId: 'local' } }])) },
    tabOrder: Object.values(openLeads),
    tasksStore: {
      get: (taskId: string) => ({ sessions: [leadLink(`${taskId}-lead`)], ownerHost: async () => 'local' }),
    },
    goToTask: (taskId: string) => pages.push(taskId),
    selectTab: (tabId: string) => selectedTabs.push(tabId),
    showExplicitSidebarTaskSession: () => {},
  }
  const opening = new SessionOpening(workspace)
  // The resume itself is measured elsewhere (session-first-paint); here it is
  // a host whose transcript read has not answered yet.
  opening.resumeSession = (meta: SessionMeta, opts: Resume['opts']) => new Promise<string>((resolve) => {
    resumes.push({ meta, opts, finish: () => resolve(`tab:${meta.sessionId}`) })
  })
  return { opening, pages, selectedTabs, resumes }
}

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  focusRequests.length = 0
  metaReads.clear()
})

test('the task page opens when the lead is shown, before its transcript loads', async () => {
  const { opening, pages, resumes } = harness()
  const opened = opening.openTaskLinkedSession(taskRecord('task-a'))
  await settle()
  metaReads.get('task-a-lead')?.({ sessionId: 'task-a-lead', serverId: 'local', provider: 'codex' } as SessionMeta)
  await settle()
  expect(resumes).toHaveLength(1)
  expect(pages).toEqual([])

  resumes[0].opts.onShown?.('tab:task-a-lead')
  expect(pages).toEqual(['task-a'])

  resumes[0].finish()
  await opened
  // Once, not again after the transcript.
  expect(pages).toEqual(['task-a'])
  expect(focusRequests).toHaveLength(1)
})

test('a lead the resume found already open still gets its page', async () => {
  const { opening, pages, resumes } = harness()
  const opened = opening.openTaskLinkedSession(taskRecord('task-a'))
  await settle()
  metaReads.get('task-a-lead')?.({ sessionId: 'task-a-lead', serverId: 'local', provider: 'codex' } as SessionMeta)
  await settle()
  resumes[0].finish()
  await opened
  expect(pages).toEqual(['task-a'])
})

test('a task clicked past before its lead metadata lands does not open', async () => {
  const { opening, pages, selectedTabs, resumes } = harness({ 'task-b-lead': 'tab-b' })
  const slow = opening.openTaskLinkedSession(taskRecord('task-a'))
  await settle()
  await opening.openTaskLinkedSession(taskRecord('task-b'))
  expect(selectedTabs).toEqual(['tab-b'])
  expect(pages).toEqual(['task-b'])

  metaReads.get('task-a-lead')?.({ sessionId: 'task-a-lead', serverId: 'local', provider: 'codex' } as SessionMeta)
  await slow
  expect(resumes).toHaveLength(0)
  expect(pages).toEqual(['task-b'])
  expect(focusRequests).toHaveLength(1)
})

test('a task clicked past during its resume neither shows its page nor takes focus', async () => {
  const { opening, pages, resumes } = harness({ 'task-b-lead': 'tab-b' })
  const slow = opening.openTaskLinkedSession(taskRecord('task-a'))
  await settle()
  metaReads.get('task-a-lead')?.({ sessionId: 'task-a-lead', serverId: 'local', provider: 'codex' } as SessionMeta)
  await settle()
  expect(resumes[0].opts.stillWanted?.()).toBe(true)

  await opening.openTaskLinkedSession(taskRecord('task-b'))
  // The resume reads this before it opens a tab, so the late tab never steals the screen.
  expect(resumes[0].opts.stillWanted?.()).toBe(false)
  resumes[0].opts.onShown?.('tab:task-a-lead')
  resumes[0].finish()
  await slow
  expect(pages).toEqual(['task-b'])
  expect(focusRequests).toHaveLength(1)
})

// ── Title repair on page open ──

const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const stub = (name: string, source: string) => runes.module(name, source)
const file = SvelteRunes.file
const calls: string[] = []
const titleAnswers = new Map<string, string | null | Error>()
const connections = runes.module('repair-server-connections', `
  export const calls = []
  export const serverConnections = {
    connectedServerIds: () => [],
    onConnectionCreated: () => () => {},
    onPhaseChange: () => () => {},
    defaultServerId: () => 'local',
    apiFor: () => globalThis.__repairApi,
  }
`)
;(globalThis as unknown as { __repairApi: object }).__repairApi = {
  ensureBackgroundSessionTitle: async (sessionId: string) => {
    calls.push(`ensure:${sessionId}`)
    const answer = titleAnswers.get(sessionId) ?? null
    if (answer instanceof Error) throw answer
    return answer
  },
  setSessionTitle: async (sessionId: string) => { calls.push(`copy:${sessionId}`) },
  tasksForSession: async (sessionId: string) => { calls.push(`refresh:${sessionId}`); return null },
}
const taskModule = runes.source('repair-task', 'packages/workspace-ui/src/contexts/tasks/task.svelte.ts', {
  '@solus/client-core/server-connections': connections,
  '@solus/contracts/task-types': file('packages/contracts/src/task-types.ts'),
  './task-reconcile': file('packages/workspace-ui/src/contexts/tasks/task-reconcile.ts'),
  './upstream-task-details': file('packages/workspace-ui/src/contexts/tasks/upstream-task-details.ts'),
  './task-title-regeneration': file('packages/workspace-ui/src/contexts/tasks/task-title-regeneration.ts'),
  './task-snoozes.store.svelte': stub('repair-task-snoozes', 'export const taskSnoozesStore = { start() {}, snoozeOf: () => null }'),
})
const storeModule = runes.source('repair-tasks-store', 'packages/workspace-ui/src/contexts/tasks/tasks.store.svelte.ts', {
  'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
  '@solus/client-core/server-connections': connections,
  '@solus/client-core/host-key': file('packages/client-core/src/host-key.ts'),
  '@solus/contracts/repository-key': file('packages/contracts/src/repository-key.ts'),
  '@solus/contracts/task-types': file('packages/contracts/src/task-types.ts'),
  '../../lib/sessionUtils': stub('repair-session-utils', 'export const attemptServerId = () => "local"'),
  '../../lib/organization-filter': file('packages/workspace-ui/src/lib/organization-filter.ts'),
  '../hosts/hosts.svelte': stub('repair-hosts', 'export const hosts = { hasCollaboration: () => true, hasExecution: () => true }'),
  '../connections/organization-selection.store.svelte': stub('repair-organization-selection', 'export const organizationSelection = { activeOrganizationId: null }'),
  '../projects/projects.store.svelte': stub('repair-projects', 'export const projectsStore = { projectKeyFor: (_s, key) => key, checkoutsOf: () => [] }'),
  './task.svelte': taskModule,
  './task-snoozes.store.svelte': stub('repair-snoozes', 'export const taskSnoozesStore = { start() {}, snoozeOf: () => null }'),
})
const { TasksStore } = await import(storeModule)

function worker(sessionId: string, sessionTitle: string | null): TaskSessionLink {
  return { sessionId, sessionTitle, provider: 'codex', model: null, startedAt: null, lastActivityAt: null, linkedAt: 1 } as TaskSessionLink
}

test('title repair asks each session once and reads back only a changed title', async () => {
  calls.length = 0
  titleAnswers.clear()
  titleAnswers.set('named', 'Named worker')
  titleAnswers.set('renamed', 'Fresh title')
  const store = new TasksStore()
  const links = [worker('lead', null), worker('named', 'Named worker'), worker('renamed', 'Fix the bug please…')]

  await store.repairWorkerTitles('task-1', links)
  expect(calls.sort()).toEqual(['ensure:lead', 'ensure:named', 'ensure:renamed', 'refresh:renamed'])

  // The page re-runs this whenever its attempt rows change. A lead's null and
  // a title already on the task must not be asked again.
  calls.length = 0
  await store.repairWorkerTitles('task-1', links)
  expect(calls).toEqual([])
})

test('title repair retries a host that failed, on a later open', async () => {
  calls.length = 0
  titleAnswers.clear()
  titleAnswers.set('offline', new Error('host offline'))
  const store = new TasksStore()
  await store.repairWorkerTitles('task-1', [worker('offline', null)])
  titleAnswers.set('offline', 'Back online')
  await store.repairWorkerTitles('task-1', [worker('offline', null)])
  expect(calls).toEqual(['ensure:offline', 'ensure:offline', 'refresh:offline'])
})
