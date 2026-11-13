import type {
  Task as TaskRecord,
  TaskSessionLink,
  TaskSnooze,
  TaskSourceState,
  TaskSummary,
} from '@solus/contracts/task-types'
import type { TaskSource } from '@solus/contracts/task-sources'
import { singleHostServerConnections } from './server-connections-mock'
import { SvelteRunes } from './svelte-runes'

/**
 * The renderer's task stores on Svelte's real runtime, with fake hosts.
 *
 * `Task.sessions`, `Task.prLinks` and the sources by key are `$derived`. A rune stand-in that computes them once would freeze
 * them at their first value, so the stores are compiled as the app compiles
 * them. Each world has its own connection registry, hosts and settings, so one
 * test cannot change what another reads. Each world also compiles into its own
 * directory: Bun does not see a file that appears in a directory after the
 * first import from it.
 */

type TasksStoreClass = typeof import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')['TasksStore']
type TaskSourcesStore = import('@solus/workspace-ui/contexts/tasks/task-sources.store.svelte').TaskSourcesStore

interface WorldGlobals {
  serverConnections: object
  hosts: { hasCollaboration(serverId: string): boolean; hasExecution(serverId: string): boolean }
  taskSnoozesStore: {
    start(): void
    get(taskId: string): TaskSnooze | undefined
    snooze(serverId: string, taskId: string, until: number | null, note?: string): Promise<void>
  }
}

const worlds: WorldGlobals[] = []
const compilers: SvelteRunes[] = []
;(globalThis as unknown as { __tasksWorlds: WorldGlobals[] }).__tasksWorlds = worlds

export interface TasksWorld {
  connections: ReturnType<typeof singleHostServerConnections>
  /** Register a host after the stores exist, as a restored tab or a dispatch does. */
  connectHost(serverId: string, api: object): void
  /** Hosts that hold only attachments, such as the organization's Solus API. */
  attachmentOnlyHosts: Set<string>
  snoozes: Map<string, TaskSnooze>
  snoozeCalls: Array<{ serverId: string; taskId: string; until: number | null; note: string }>
  TasksStore: TasksStoreClass
  taskSourcesStore: TaskSourcesStore
  /** Change the person's task sources, as a write of their settings does. */
  setSources(sources: TaskSource[]): void
  /** The compiled `task.svelte.ts` and `tasks.store.svelte.ts`, for a test that compiles a reader of them. */
  modules: { task: string; tasksStore: string; taskSources: string; connections: string }
}

const file = SvelteRunes.file
const tasks = 'packages/workspace-ui/src/contexts/tasks'

/** Remove what every world compiled. Call it from `afterAll`. */
export function disposeTasksWorlds(): void {
  for (const runes of compilers.splice(0)) runes.dispose()
}

export async function createTasksWorld(): Promise<TasksWorld> {
  const index = worlds.length
  const runes = new SvelteRunes()
  compilers.push(runes)
  const base = singleHostServerConnections()
  const connectionListeners = new Set<(connection: { serverId: string }) => void>()
  const connections = {
    ...base,
    onConnectionCreated: (listener: (connection: { serverId: string }) => void) => {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
  }
  const attachmentOnlyHosts = new Set<string>()
  const snoozes = new Map<string, TaskSnooze>()
  const snoozeCalls: TasksWorld['snoozeCalls'] = []
  worlds.push({
    serverConnections: connections,
    hosts: {
      hasCollaboration: () => true,
      hasExecution: (serverId) => !attachmentOnlyHosts.has(serverId),
    },
    taskSnoozesStore: {
      start: () => {},
      get: (taskId) => snoozes.get(taskId),
      snooze: async (serverId, taskId, until, note = '') => { snoozeCalls.push({ serverId, taskId, until, note }) },
    },
  })

  const world = `globalThis.__tasksWorlds[${index}]`
  const stub = (name: string, source: string) => runes.module(`${name}-${index}`, source)
  const connectionsModule = stub('connections', `export const serverConnections = ${world}.serverConnections`)
  const hostsModule = stub('hosts', `export const hosts = ${world}.hosts`)
  const snoozesModule = stub('snoozes', `export const taskSnoozesStore = ${world}.taskSnoozesStore`)
  // The same rule as `attemptServerId` in `lib/sessionUtils`, which imports icons.
  const sessionUtilsModule = stub('session-utils', `
    export const attemptServerId = ({ link, liveServerId, taskServerId }) =>
      liveServerId ?? (link.executionServerId ? ${world}.serverConnections.resolveId(link.executionServerId) : null) ?? taskServerId
  `)
  const shared = {
    'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
    '@solus/client-core/server-connections': connectionsModule,
    '@solus/client-core/host-key': file('packages/client-core/src/host-key.ts'),
    '@solus/contracts/task-types': file('packages/contracts/src/task-types.ts'),
    '../hosts/hosts.svelte': hostsModule,
    './task-snoozes.store.svelte': snoozesModule,
    './task-reconcile': file(`${tasks}/task-reconcile.ts`),
    './task-links': file(`${tasks}/task-links.ts`),
    '@solus/contracts/task-sources': file('packages/contracts/src/task-sources.ts'),
  }
  const hostEventsModule = runes.source(`host-events-${index}`, 'packages/client-core/src/host-events.ts', {
    './server-connections': connectionsModule,
  })
  const taskSources = runes.source(`task-sources-${index}`, `${tasks}/task-sources.store.svelte.ts`, {
    ...shared,
    '@solus/client-core/host-events': hostEventsModule,
  })
  const task = runes.source(`task-${index}`, `${tasks}/task.svelte.ts`, shared)
  const tasksStore = runes.source(`tasks-store-${index}`, `${tasks}/tasks.store.svelte.ts`, {
    ...shared,
    '../../lib/sessionUtils': sessionUtilsModule,
    './task.svelte': task,
    './task-sources.store.svelte': taskSources,
  })

  const { TasksStore } = await import(tasksStore) as { TasksStore: TasksStoreClass }
  const { taskSourcesStore } = await import(taskSources) as { taskSourcesStore: TaskSourcesStore }
  // The person's settings: no source until a test names some.
  const settingsListeners = new Set<(change: { set: object; reset: readonly string[] }) => void>()
  const settings = {
    values: { taskSources: [] as TaskSource[] },
    onChange: (listener: (change: { set: object; reset: readonly string[] }) => void) => {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    },
  }
  taskSourcesStore.useSources(settings)
  return {
    connections: base,
    connectHost: (serverId, api) => {
      const connection = base.registerHost(serverId, api)
      for (const listener of [...connectionListeners]) listener(connection)
    },
    attachmentOnlyHosts,
    snoozes,
    snoozeCalls,
    TasksStore,
    taskSourcesStore,
    setSources: (sources) => {
      settings.values = { taskSources: sources }
      for (const listener of [...settingsListeners]) listener({ set: { taskSources: sources }, reset: [] })
    },
    modules: { task, tasksStore, taskSources, connections: connectionsModule },
  }
}

// ── Records ──

export const REPO_SOURCE_KEY = 'github-repo:acme/app'
export const BOARD_SOURCE_KEY = 'github-project:acme/7'
export const JIRA_SOURCE_KEY = 'jira-project:cloud-1/SOL'

/** A GitHub issue as a host's snapshot lists it. */
export function issueRow(id = 'github:I_1', overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    providerId: 'github',
    kind: 'issue',
    reference: 'acme/app#1',
    title: 'Hydrated task',
    url: 'https://github.com/acme/app/issues/1',
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: [{ sourceKey: REPO_SOURCE_KEY, columnId: 'open' }],
    labels: [],
    writableFields: ['title', 'body', 'labels', 'assignee'],
    updatedAt: 0,
    ...overrides,
  }
}

/** The same issue as a detail read answers it: with its body. */
export function issueRecord(id = 'github:I_1', overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...issueRow(id), body: '', ...overrides }
}

/** A draft item of a GitHub Project: no reference and no URL. */
export function draftRow(id = 'github:DI_1', overrides: Partial<TaskSummary> = {}): TaskSummary {
  return issueRow(id, {
    kind: 'draft',
    reference: undefined,
    url: null,
    state: { name: 'Todo', category: 'open' },
    placements: [{ sourceKey: BOARD_SOURCE_KEY, columnId: 'opt-todo' }],
    writableFields: ['title', 'body', 'assignee'],
    ...overrides,
  })
}

export function sessionLink(sessionId: string, overrides: Partial<TaskSessionLink> = {}): TaskSessionLink {
  return {
    sessionId,
    sessionTitle: null,
    provider: 'claude-code',
    model: null,
    startedAt: 1,
    lastActivityAt: 1,
    role: 'working',
    linkedAt: 1,
    ...overrides,
  }
}

export function sourceState(sourceKey: string, overrides: Partial<TaskSourceState> = {}): TaskSourceState {
  const base: Record<string, Pick<TaskSourceState, 'source' | 'label' | 'columns'>> = {
    [REPO_SOURCE_KEY]: {
      source: { kind: 'github-repo', owner: 'acme', repo: 'app' },
      label: 'acme/app',
      columns: [
        { id: 'open', name: 'Open', category: 'open' },
        { id: 'closed', name: 'Closed', category: 'done' },
      ],
    },
    [BOARD_SOURCE_KEY]: {
      source: { kind: 'github-project', owner: 'acme', number: 7 },
      label: 'Roadmap',
      columns: [
        { id: 'opt-todo', name: 'Todo', category: 'open' },
        { id: 'opt-doing', name: 'In progress', category: 'active' },
        { id: 'opt-done', name: 'Shipped', category: 'done' },
      ],
    },
    [JIRA_SOURCE_KEY]: {
      source: { kind: 'jira-project', cloudId: 'cloud-1', projectKey: 'SOL' },
      label: 'SOL',
      columns: [
        { id: '1', name: 'To Do', category: 'open' },
        { id: '3', name: 'In Progress', category: 'active' },
        { id: '5', name: 'Done', category: 'done' },
      ],
    },
  }
  const known = base[sourceKey]
  if (!known) throw new Error(`No fixture for task source ${sourceKey}`)
  return { sourceKey, ...known, health: 'ok', fetchedAt: 1_000, ...overrides }
}

/** A snapshot answer of a host. */
export function snapshotOf(
  rows: TaskSummary[],
  sessionsByTask: Record<string, TaskSessionLink[]> = {},
): { tasks: TaskSummary[]; sessionsByTask: Record<string, TaskSessionLink[]> } {
  return { tasks: rows, sessionsByTask }
}

/** Let the reads that are already answered land. Not a wait on time. */
export async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve()
}
