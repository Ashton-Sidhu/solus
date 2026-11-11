import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import type { SessionMeta } from '@solus/contracts/types'
import type { Task, TaskSessionLink } from '@solus/contracts/task-types'
import { createTasksWorld, disposeTasksWorlds, issueRecord } from './helpers/tasks-world'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

// WHY: jumping back to a task's work resumes its latest session. A task the
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
  CHATS_GROUP_KEY: 'solus:chats',
  groupKeyFor: (_serverId: string, projectKey: string) => projectKey,
}))
mock.module(`${workspaceUi}/components/review/review-guide.store.svelte`, () => ({
  reviewGuideStore: {}, sessionGuideIdentity: () => null,
}))
mock.module(`${workspaceUi}/lib/toasts`, () => ({ toasts: {} }))
mock.module(`${workspaceUi}/lib/analytics`, () => ({ track: () => {} }))
mock.module(`${workspaceUi}/contexts/workspace/session-draft.svelte`, () => ({ ownedTaskId: () => null }))

const { SessionOpening } = await import(`${workspaceUi}/contexts/workspace/session-opening`)

function attemptLink(sessionId: string): TaskSessionLink {
  return { sessionId, role: 'working', sessionTitle: null, provider: 'codex', model: null, startedAt: null, lastActivityAt: null, linkedAt: 1 } as TaskSessionLink
}

function taskRecord(id: string): Task {
  return issueRecord(id, { title: id, category: 'active' })
}

interface Resume {
  meta: SessionMeta
  opts: { stillWanted?: () => boolean }
  finish: () => void
}

function harness(openSessions: Record<string, string> = {}) {
  const selectedTabs: string[] = []
  const resumes: Resume[] = []
  const workspace = {
    tabs: Object.fromEntries(Object.entries(openSessions).map(([sessionId, tabId]) => [tabId, { id: tabId, sessionId }])),
    sessions: { byId: Object.fromEntries(Object.entries(openSessions).map(([sessionId]) => [sessionId, { id: sessionId, agentSessionId: sessionId, run: { location: folderLocation({ serverId: 'local', path: '/repo' }) } }])) },
    tabOrder: Object.values(openSessions),
    tasksStore: {
      get: (taskId: string) => ({ sessions: [attemptLink(`${taskId}-session`)], ownerHost: async () => 'local' }),
    },
    selectTab: (tabId: string) => selectedTabs.push(tabId),
  }
  const opening = new SessionOpening(workspace)
  // The resume itself is measured elsewhere (session-first-paint); here it is
  // a host whose transcript read has not answered yet.
  opening.resumeSession = (meta: SessionMeta, opts: Resume['opts']) => new Promise<string>((resolve) => {
    resumes.push({ meta, opts, finish: () => resolve(`tab:${meta.sessionId}`) })
  })
  return { opening, selectedTabs, resumes }
}

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  focusRequests.length = 0
  metaReads.clear()
})

test('a task clicked past before its session metadata lands does not open', async () => {
  const { opening, selectedTabs, resumes } = harness({ 'task-b-session': 'tab-b' })
  const slow = opening.openTaskLinkedSession(taskRecord('task-a'))
  await settle()
  await opening.openTaskLinkedSession(taskRecord('task-b'))
  expect(selectedTabs).toEqual(['tab-b'])

  metaReads.get('task-a-session')?.({ sessionId: 'task-a-session', serverId: 'local', provider: 'codex' } as SessionMeta)
  await slow
  expect(resumes).toHaveLength(0)
  expect(focusRequests).toHaveLength(1)
})

test('a task clicked past during its resume does not take focus', async () => {
  const { opening, resumes } = harness({ 'task-b-session': 'tab-b' })
  const slow = opening.openTaskLinkedSession(taskRecord('task-a'))
  await settle()
  metaReads.get('task-a-session')?.({ sessionId: 'task-a-session', serverId: 'local', provider: 'codex' } as SessionMeta)
  await settle()
  expect(resumes[0].opts.stillWanted?.()).toBe(true)

  await opening.openTaskLinkedSession(taskRecord('task-b'))
  // The resume reads this before it opens a tab, so the late tab never steals the screen.
  expect(resumes[0].opts.stillWanted?.()).toBe(false)
  resumes[0].finish()
  await slow
  expect(focusRequests).toHaveLength(1)
})

// ── Title repair on page open ──

afterAll(disposeTasksWorlds)
const TASK = 'github:I_1'

/** One host that reads the task and runs its sessions. */
async function repairHarness(titleAnswers: Map<string, string | null | Error>) {
  const calls: string[] = []
  const world = await createTasksWorld()
  world.connections.registerPrimary('local', {
    tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
    ensureBackgroundSessionTitle: async (sessionId: string) => {
      calls.push(`ensure:${sessionId}`)
      const answer = titleAnswers.get(sessionId) ?? null
      if (answer instanceof Error) throw answer
      return answer
    },
    setSessionTitle: async (sessionId: string) => { calls.push(`copy:${sessionId}`) },
    tasksForSession: async (sessionId: string) => { calls.push(`refresh:${sessionId}`); return null },
  })
  const store = new world.TasksStore()
  await store.ensureLoaded()
  store.get(TASK).hydrate(issueRecord(TASK), 'local')
  return { store, calls }
}

function worker(sessionId: string, sessionTitle: string | null): TaskSessionLink {
  return { sessionId, sessionTitle, provider: 'codex', model: null, startedAt: null, lastActivityAt: null, linkedAt: 1 }
}

test('title repair asks each session once and reads back only a changed title', async () => {
  const { store, calls } = await repairHarness(new Map([['named', 'Named worker'], ['renamed', 'Fresh title']]))
  const links = [worker('lead', null), worker('named', 'Named worker'), worker('renamed', 'Fix the bug please…')]

  await store.repairWorkerTitles(TASK, links)
  expect(calls.sort()).toEqual(['ensure:lead', 'ensure:named', 'ensure:renamed', 'refresh:renamed'])

  // The page re-runs this whenever its attempt rows change. A lead's null and
  // a title already on the task must not be asked again.
  calls.length = 0
  await store.repairWorkerTitles(TASK, links)
  expect(calls).toEqual([])
})

test('title repair retries a host that failed, on a later open', async () => {
  const titleAnswers = new Map<string, string | null | Error>([['offline', new Error('host offline')]])
  const { store, calls } = await repairHarness(titleAnswers)
  await store.repairWorkerTitles(TASK, [worker('offline', null)])
  titleAnswers.set('offline', 'Back online')
  await store.repairWorkerTitles(TASK, [worker('offline', null)])
  expect(calls).toEqual(['ensure:offline', 'ensure:offline', 'refresh:offline'])
})
