import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('@solus/workspace-ui/lib/analytics', () => ({
  identifyInstallation: () => {},
  initAnalytics: () => {},
  registerSuperProps: () => {},
  setAnalyticsEnabled: () => {},
  track: () => {},
}))

const previousAudio = globalThis.Audio
const previousCustomEvent = globalThis.CustomEvent
const previousDocument = globalThis.document
const previousDerived = (globalThis as unknown as { $derived?: unknown }).$derived
const previousEffect = (globalThis as unknown as { $effect?: unknown }).$effect
const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousWindow = globalThis.window

interface WorkCommentSendContext {
  activeTabId: string
  sendMessage(prompt: string, projectPath?: string, tabId?: string): boolean
  sessionFor(tabId: string): { run: { workingDirectory: string } } | undefined
  openWork(workId: string, target: 'focused' | 'aside'): void
  worksStore: {
    get(workId: string): { cwd: string } | undefined
    hostFor(workId: string): string | null
    ensureContent(workId: string, reason: string, cwd?: string): Promise<boolean>
  }
  tasksStore: {
    ensureLinkedTasks(
      targets: Array<{ kind: 'work'; targetScope: string; targetKey: string }>,
      serverId?: string,
    ): Promise<void>
    linkedTasksFor(target: { kind: 'work'; targetScope: string; targetKey: string }):
      | Array<{ taskId: string }>
      | undefined
  }
  router: {
    leadingPane: { id: string }
    closeGroup(group: string): void
    navigate(route: { name: string; params: { sessionId?: string } }, options: { target: string }): void
  }
  createSessionDraft(options: { taskId?: string; withoutTask?: boolean; workId: string }, cwd?: string): {
    id: string
    run: { taskServerId: string }
  }
  startSessionDraft(draftId: string, options: { via: string }): string | null
}

let sendMessageToNewWorkSession: (
  this: WorkCommentSendContext,
  workId: string,
  prompt: string,
) => Promise<boolean>

beforeAll(async () => {
  ;(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
    <T>(value: T) => value,
    { by: <T>(read: () => T) => read() },
  )
  ;(globalThis as unknown as { $effect: unknown }).$effect = Object.assign(
    () => {},
    { pre: () => {}, root: () => () => {} },
  )
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { raw: <T>(value: T) => value, snapshot: <T>(value: T) => value },
  )
  Object.defineProperty(globalThis, 'Audio', {
    configurable: true,
    value: class { volume = 1 },
  })
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class { constructor(_name: string, _options?: unknown) {} },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener: () => {},
      documentElement: { classList: { contains: () => false, toggle: () => {} } },
      hasFocus: () => true,
      removeEventListener: () => {},
      visibilityState: 'visible',
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => {},
      dispatchEvent: () => true,
      matchMedia: () => ({
        addEventListener: () => {},
        matches: false,
        removeEventListener: () => {},
      }),
      removeEventListener: () => {},
    },
  })
  const { WorkspaceContext } = await import('@solus/workspace-ui/contexts/workspace/workspace.context.svelte')
  sendMessageToNewWorkSession = WorkspaceContext.prototype.sendMessageToNewWorkSession as unknown as typeof sendMessageToNewWorkSession
})

afterAll(() => {
  for (const [name, previous] of [
    ['Audio', previousAudio],
    ['CustomEvent', previousCustomEvent],
    ['document', previousDocument],
    ['localStorage', previousLocalStorage],
    ['window', previousWindow],
  ] as const) {
    if (previous === undefined) delete (globalThis as unknown as { [key: string]: unknown })[name]
    else Object.defineProperty(globalThis, name, { configurable: true, value: previous })
  }
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as { $derived?: unknown }).$derived
  else (globalThis as unknown as { $derived: unknown }).$derived = previousDerived
  if (previousEffect === undefined) delete (globalThis as unknown as { $effect?: unknown }).$effect
  else (globalThis as unknown as { $effect: unknown }).$effect = previousEffect
})

function contextWith(events: string[], owningTaskId: string | null = 'task-1'): WorkCommentSendContext {
  return {
    activeTabId: 'source-tab',
    sendMessage: (prompt, _projectPath, tabId) => {
      events.push(`send:${tabId}:${prompt}`)
      return true
    },
    sessionFor: () => ({ run: { workingDirectory: '/source' } }),
    openWork: (workId, target) => events.push(`work:${workId}:${target}`),
    worksStore: {
      get: () => ({ cwd: '/repo' }),
      hostFor: () => 'task-host',
      ensureContent: async () => true,
    },
    tasksStore: {
      ensureLinkedTasks: async (targets, serverId) => {
        events.push(`lookup:${targets[0]?.targetKey}:${serverId}`)
      },
      linkedTasksFor: () => owningTaskId ? [{ taskId: owningTaskId }] : [],
    },
    router: {
      leadingPane: { id: 'leading' },
      closeGroup: (group) => events.push(`close:${group}`),
      navigate: (route, options) => events.push(`navigate:${route.name}:${options.target}`),
    },
    createSessionDraft: (options, cwd) => {
      const taskTarget = options.taskId ?? (options.withoutTask ? 'none' : 'new')
      events.push(`create:${taskTarget}:${options.workId}:${cwd}`)
      return { id: 'work-draft', run: { taskServerId: 'old-host' } }
    },
    startSessionDraft: (draftId) => {
      events.push(`start:${draftId}`)
      return 'work-tab'
    },
  }
}

describe('sending work comments', () => {
  test('starts a new session on the task linked to the work', async () => {
    // WHY: each sent comment round is a new attempt on the document's task. It
    // must not reuse an earlier work chat or stop at an empty draft composer.
    const events: string[] = []

    expect(await sendMessageToNewWorkSession.call(contextWith(events), 'work-1', 'Fix this note')).toBe(true)

    expect(events).toEqual([
      'lookup:work-1:task-host',
      'close:page',
      'work:work-1:aside',
      'create:task-1:work-1:/repo',
      'start:work-draft',
      'navigate:chat:leading',
      'send:work-tab:Fix this note',
    ])
  })

  test('starts a taskless session when the work has no linked task', async () => {
    // WHY: user-authored works can exist outside a task. Their feedback still
    // starts immediately, but it must not mint an unrelated task as a side effect.
    const events: string[] = []

    expect(
      await sendMessageToNewWorkSession.call(contextWith(events, null), 'work-1', 'Fix this note'),
    ).toBe(true)

    expect(events).toContain('create:none:work-1:/repo')
    expect(events).toContain('send:work-tab:Fix this note')
  })
})
