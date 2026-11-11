import { afterAll, expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'
import { createTasksWorld, disposeTasksWorlds, issueRecord } from './helpers/tasks-world'

// WHY: a deep link opens the task page on an empty store, and the page asks
// `peek` before any read has named the task. `byId` is a plain Map, so a peek
// that found nothing tracked nothing: the detail read then filled the task in,
// but the page kept its first answer and said the task no longer exists.

const runes = new SvelteRunes()
afterAll(() => {
  runes.dispose()
  disposeTasksWorlds()
})

const world = await createTasksWorld()
const detailReads: string[] = []
world.connections.registerPrimary('local', {
  tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
  tasksGet: async (id: string) => {
    detailReads.push(id)
    return { task: issueRecord(id, { title: 'Opened by its key' }), comments: [], links: [], activity: [] }
  },
})
const fixture = runes.module('fixture', `
  import { flushSync } from 'svelte'
  import { TasksStore } from ${JSON.stringify(world.modules.tasksStore)}
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

test('a task page opened before its task was read shows the task once the read lands', async () => {
  const { tasks, page, flush } = open('github:I_deep_link')
  expect(page.title).toBeNull()

  await tasks.get('github:I_deep_link').loadDetails()
  flush()

  expect(detailReads).toContain('github:I_deep_link')
  expect(page.title).toBe('Opened by its key')
})
