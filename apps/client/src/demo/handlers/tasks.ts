import { arg, optionalArg } from './args'
import type {
  PrepareSessionTaskRequest,
  Task,
  TaskAssigneeCandidate,
  TaskAttachments,
  TaskCreateInput,
  TaskDetails,
  TaskLinkInput,
  TaskLinkKind,
  TaskLinkTarget,
  TaskLinkedTask,
  TaskMoveTarget,
  TaskSessionRole,
  TaskSidebarFilter,
  TaskSidebarPrLink,
  TaskSnapshot,
  TaskSnooze,
  TaskSourceOptions,
  TaskSummary,
  TaskUpdatePatch,
} from '@solus/contracts/task-types'
import type { TaskSource } from '@solus/contracts/task-sources'
import { type DemoServer } from '../fixtures/types'
import { type DemoStore } from '../store'

/** What the demo's GitHub and Jira connections offer as a task source. The
 *  first Project and the first board are the two sources of the demo's
 *  personal settings. */
const DEMO_SOURCE_OPTIONS: TaskSourceOptions = {
  github: {
    connected: true,
    login: 'acme-dev',
    hasProjectScope: true,
    repositories: [
      { owner: 'acme', repo: 'api-gateway' },
      { owner: 'acme', repo: 'web' },
    ],
    projects: [
      { owner: 'acme', number: 4, title: 'API Platform roadmap' },
      { owner: 'acme', number: 7, title: 'Developer experience' },
    ],
  },
  jira: {
    connected: true,
    cloudId: 'acme-cloud',
    siteUrl: 'https://acme.atlassian.net',
    projects: [
      { projectKey: 'ACME', name: 'Acme Platform' },
      { projectKey: 'WEB', name: 'Web' },
    ],
    boards: [
      { boardId: 12, name: 'ACME board', projectKey: 'ACME' },
      { boardId: 15, name: 'Web sprint board', projectKey: 'WEB' },
    ],
  },
}

function taskSummary({ body: _body, epic: _epic, ...summary }: Task): TaskSummary {
  return summary
}

function taskAttachments(store: DemoStore, id: string): TaskAttachments {
  return { links: store.taskLinksFor(id), activity: [] }
}

function taskDetails(store: DemoStore, id: string): TaskDetails {
  return { task: store.getTask(id), comments: store.taskComments(id), ...taskAttachments(store, id) }
}

function taskSnapshot(store: DemoStore, id: string): TaskSnapshot {
  return { details: taskDetails(store, id), sessions: store.taskSessions()[id] ?? [] }
}

export function registerTasksHandlers(backend: DemoServer, store: DemoStore): void {
  /** A change of one task's fields, comments or attachments. */
  const taskChanged = (taskId: string): void => backend.broadcast('tasks.invalidated', { taskId })
  /** A change of where a task is: the sources that list it are read again too. */
  const placementChanged = (task: Task): void => {
    taskChanged(task.id)
    backend.broadcast('tasks.sourcesChanged', { sourceKeys: task.placements.map((placement) => placement.sourceKey) })
  }

  // The visitor's personal settings name the sources: at first a GitHub
  // Project and a Jira board (`seedDemoStorage`).
  backend.register('tasksSources', (args) => store.taskSourceStates(arg<TaskSource[]>(args, 0)))
  backend.register('tasksSourceOptions', () => DEMO_SOURCE_OPTIONS)
  backend.register('tasksSearch', (args) => {
    const query = arg<string>(args, 1).trim().toLowerCase()
    return store.listTasks()
      .filter((task) => `${task.reference ?? ''} ${task.title}`.toLowerCase().includes(query))
      .map(taskSummary)
  })
  // The demo's comments are a provider's, which a host does not search
  // (docs/plans/unified-search.md, Known differences).
  backend.register('tasksSearchComments', () => [])
  // A host answers a task's pull requests with the links its sessions own.
  backend.register('tasksSidebarSnapshot', (args) => {
    const taskIds = optionalArg<TaskSidebarFilter>(args, 0)?.taskIds
    return {
      tasks: store.listTasks().filter((task) => !taskIds || taskIds.includes(task.id)).map(taskSummary),
      sessionsByTask: store.taskSessions(),
      prLinkListsByTask: Object.fromEntries(Object.entries(store.taskSessions()).map(([taskId, sessions]) => [
        taskId,
        sessions.flatMap(({ sessionId }) => store.sessionPullRequests(sessionId)).map((link) => {
          const prLink: TaskSidebarPrLink = {
            number: link.number,
            title: link.title,
            targetScope: link.repository,
            url: link.url,
            createdBy: { kind: 'system' },
            ownerSessionId: link.sessionId,
          }
          if (link.snapshot) prLink.snapshot = link.snapshot
          return prLink
        }),
      ])),
    }
  })
  backend.register('tasksGet', (args) => taskDetails(store, arg<string>(args, 0)))
  backend.register('tasksAttachments', (args) => taskAttachments(store, arg<string>(args, 0)))
  backend.register('tasksSnapshot', (args) => taskSnapshot(store, arg<string>(args, 0)))
  backend.register('tasksPrepareForSession', (args) => {
    const input = arg<PrepareSessionTaskRequest>(args, 0)
    return {
      task: store.getTask(input.taskId),
      snapshot: input.includeSnapshot ? taskSnapshot(store, input.taskId) : null,
    }
  })
  backend.register('tasksSessions', (args) => {
    const taskId = optionalArg<string>(args, 0)
    const sessions = store.taskSessions()
    return taskId ? { [taskId]: sessions[taskId] ?? [] } : sessions
  })
  backend.register('tasksCreate', (args) => {
    const task = store.createTask(arg<TaskCreateInput>(args, 0))
    placementChanged(task)
    return task
  })
  backend.register('tasksUpdate', (args) => {
    const task = store.updateTask(arg<string>(args, 0), arg<TaskUpdatePatch>(args, 1))
    taskChanged(task.id)
    return task
  })
  backend.register('tasksMove', (args) => {
    const task = store.moveTask(arg<string>(args, 0), arg<TaskMoveTarget>(args, 1))
    placementChanged(task)
    return task
  })
  backend.register('tasksDelete', (args) => {
    const id = arg<string>(args, 0)
    const sourceKeys = store.listTasks().find((task) => task.id === id)?.placements.map((placement) => placement.sourceKey) ?? []
    const deleted = store.deleteTask(id)
    if (deleted) {
      taskChanged(id)
      backend.broadcast('tasks.sourcesChanged', { sourceKeys })
    }
    return deleted
  })
  backend.register('tasksMarkRead', (args) => {
    const task = store.setTaskRead(arg<string>(args, 0), arg<boolean>(args, 1))
    taskChanged(task.id)
    return task
  })
  // The demo has one person, so their snoozes are this one map, apart from the
  // task records as on a host.
  const snoozes = new Map<string, TaskSnooze>()
  backend.register('tasksSnooze', (args) => {
    const id = arg<string>(args, 0)
    const until = arg<number | null>(args, 1)
    const note = arg<string | undefined>(args, 2)?.trim()
    if (until === null) snoozes.delete(id)
    else snoozes.set(id, note ? { taskId: id, snoozedUntil: until, snoozeNote: note } : { taskId: id, snoozedUntil: until })
    backend.broadcast('tasks.snoozesChanged', {})
    return snoozes.get(id) ?? null
  })
  backend.register('tasksSnoozes', () => [...snoozes.values()])

  backend.register('tasksComment', (args) => {
    const id = arg<string>(args, 0)
    store.commentTask(id, arg<string>(args, 1))
    taskChanged(id)
    return taskDetails(store, id)
  })
  backend.register('tasksRetryComment', (args) => {
    const id = arg<string>(args, 0)
    store.retryTaskComment(id, arg<string>(args, 1))
    taskChanged(id)
    return taskDetails(store, id)
  })
  backend.register('tasksDeleteComment', (args) => {
    const id = arg<string>(args, 0)
    store.discardTaskComment(id, arg<string>(args, 1))
    taskChanged(id)
    return taskDetails(store, id)
  })
  // The demo's providers permit the people who already have a task.
  backend.register('tasksListAssigneeCandidates', (): TaskAssigneeCandidate[] =>
    [...new Set(store.listTasks().flatMap((task) => task.assignee ?? []))].sort().map((login) => ({ login })))
  backend.register('tasksLinkSession', (args) => {
    const taskId = arg<string>(args, 0)
    store.linkTaskSession(taskId, arg<string>(args, 1), optionalArg<TaskSessionRole>(args, 2))
    taskChanged(taskId)
  })
  backend.register('tasksUnlinkSession', (args) => {
    const taskId = arg<string>(args, 0)
    store.unlinkTaskSession(taskId, arg<string>(args, 1))
    taskChanged(taskId)
  })
  backend.register('tasksLink', (args) => {
    const taskId = arg<string>(args, 0)
    const input = arg<TaskLinkInput>(args, 1)
    store.linkTask(taskId, input)
    taskChanged(taskId)
    return taskAttachments(store, taskId)
  })
  backend.register('tasksUnlink', (args) => {
    const taskId = arg<string>(args, 0)
    const kind = arg<TaskLinkKind>(args, 1)
    const targetKey = arg<string>(args, 2)
    const targetScope = optionalArg<string>(args, 3)
    store.unlinkTask(taskId, kind, targetKey, targetScope ?? '')
    taskChanged(taskId)
    return taskAttachments(store, taskId)
  })
  backend.register('tasksLinkedTo', (args) => {
    const targets = arg<TaskLinkTarget[]>(args, 0)
    const linked: TaskLinkedTask[] = []
    for (const task of store.listTasks()) {
      for (const link of store.taskLinksFor(task.id)) {
        const wanted = targets.some((target) =>
          target.kind === link.kind && target.targetScope === link.targetScope && target.targetKey === link.targetKey)
        if (!wanted) continue
        linked.push({
          taskId: task.id,
          kind: link.kind,
          targetScope: link.targetScope,
          targetKey: link.targetKey,
          title: task.title,
          category: task.category,
          reference: task.reference,
        })
      }
    }
    return linked
  })
  backend.register('tasksAttachArtifact', (args) => {
    // The demo has no browser to render a still with; the comment stands in
    // for the one the host would file.
    const taskId = arg<string>(args, 0)
    store.commentTask(taskId, 'Interactive artifact preview attached.')
    taskChanged(taskId)
    return taskDetails(store, taskId)
  })
  backend.register('tasksForSession', (args) => {
    const sessionId = arg<string>(args, 0)
    const sessions = store.taskSessions()
    const taskId = Object.entries(sessions).find(([, links]) => links.some((link) => link.sessionId === sessionId))?.[0]
    if (!taskId) return null
    return { task: store.getTask(taskId), attempts: sessions[taskId] ?? [] }
  })
}
