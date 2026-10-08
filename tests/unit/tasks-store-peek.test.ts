import { afterAll, expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'

// WHY: a share link opens the task page on an empty store, and the page asks
// `peek` before any read has named the task. `byId` is a plain Map, so a peek
// that found nothing tracked nothing: the detail read then filled the task in,
// but the page kept its first answer and said the task no longer exists.

const runes = new SvelteRunes()
afterAll(() => runes.dispose())

const file = SvelteRunes.file
const connections = runes.module('server-connections', `
  export const detailReads = []
  export const serverConnections = {
    connectedServerIds: () => [],
    onConnectionCreated: () => () => {},
    onPhaseChange: () => () => {},
    defaultServerId: () => 'local',
    apiFor: () => ({
      tasksGet: async (id) => {
        detailReads.push(id)
        return { task: { id, providerId: 'local', title: 'Shared task', body: '', status: 'todo', url: null, labels: [], updatedAt: 1 }, comments: [], links: [], activity: [] }
      },
    }),
  }
`)
const stub = (name: string, source: string) => runes.module(name, source)
const task = runes.source('task', 'packages/workspace-ui/src/contexts/tasks/task.svelte.ts', {
  '@solus/client-core/server-connections': connections,
  '@solus/contracts/task-types': file('packages/contracts/src/task-types.ts'),
  './task-reconcile': file('packages/workspace-ui/src/contexts/tasks/task-reconcile.ts'),
  './upstream-task-details': file('packages/workspace-ui/src/contexts/tasks/upstream-task-details.ts'),
  './task-title-regeneration': file('packages/workspace-ui/src/contexts/tasks/task-title-regeneration.ts'),
})
const store = runes.source('tasks-store', 'packages/workspace-ui/src/contexts/tasks/tasks.store.svelte.ts', {
  'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
  '@solus/client-core/server-connections': connections,
  '@solus/client-core/host-key': file('packages/client-core/src/host-key.ts'),
  '@solus/contracts/repository-key': file('packages/contracts/src/repository-key.ts'),
  '@solus/contracts/task-types': file('packages/contracts/src/task-types.ts'),
  '../../lib/sessionUtils': stub('session-utils', 'export const attemptServerId = () => undefined'),
  '../../lib/organization-filter': file('packages/workspace-ui/src/lib/organization-filter.ts'),
  '../hosts/hosts.svelte': stub('hosts', 'export const hosts = { hasCollaboration: () => true, hasExecution: () => true }'),
  '../connections/organization-selection.store.svelte': stub('organization-selection', 'export const organizationSelection = { activeOrganizationId: null }'),
  '../projects/projects.store.svelte': stub('projects', 'export const projectsStore = { projectKeyFor: (_s, key) => key, checkoutsOf: () => [] }'),
  './task.svelte': task,
})
const fixture = runes.module('fixture', `
  import { flushSync } from 'svelte'
  import { TasksStore } from ${JSON.stringify(store)}
  // The task page reads \`peek\` from its template, which is an effect: read it
  // the same way, so the derived caches and invalidates as it does in the app.
  export function open(taskId) {
    const tasks = new TasksStore()
    const page = $state({ title: null })
    $effect.root(() => {
      const shown = $derived(tasks.peek(taskId))
      $effect(() => { page.title = shown?.title ?? null })
    })
    flushSync()
    return { tasks, page, flush: flushSync }
  }
`)
const { open } = await import(fixture) as {
  open(taskId: string): {
    tasks: { get(id: string): { loadDetails(): Promise<unknown> } }
    page: { title: string | null }
    flush(): void
  }
}
const { detailReads } = await import(connections) as { detailReads: string[] }

test('a task page opened before its task was read shows the task once the read lands', async () => {
  const { tasks, page, flush } = open('shared-task')
  expect(page.title).toBeNull()

  await tasks.get('shared-task').loadDetails()
  flush()

  expect(detailReads).toEqual(['shared-task'])
  expect(page.title).toBe('Shared task')
})
