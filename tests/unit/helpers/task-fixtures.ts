import { taskKey, taskSourceKey, type TaskSource, type TaskStatusCategory } from '@solus/contracts/task-sources'
import type { TaskColumn } from '@solus/contracts/task-types'
import type { TaskAdapters } from '@solus/server/data/tasks/providers/registry'
import type {
  ProviderComment,
  ProviderTask,
  SourceItem,
  SourceRead,
  TaskProviderAdapter,
  TaskSourceAdapter,
} from '@solus/server/data/tasks/providers/types'

/**
 * GitHub and Jira for a test, in memory: the tasks the "provider" owns, what
 * a read of each source answers, and a record of each call. A test never
 * makes a network call and never needs a token.
 */

export const REPO: TaskSource = { kind: 'github-repo', owner: 'acme', repo: 'app' }
export const BOARD: TaskSource = { kind: 'github-project', owner: 'acme', number: 7 }
export const JIRA: TaskSource = { kind: 'jira-project', cloudId: 'site', projectKey: 'SOL' }

export const REPO_COLUMNS: TaskColumn[] = [
  { id: 'open', name: 'Open', category: 'open' },
  { id: 'closed', name: 'Closed', category: 'done' },
]
export const BOARD_COLUMNS: TaskColumn[] = [
  { id: 'opt-todo', name: 'Todo', category: 'open' },
  { id: 'opt-doing', name: 'In progress', category: 'active' },
  { id: 'opt-done', name: 'Done', category: 'done' },
]
export const JIRA_COLUMNS: TaskColumn[] = [
  { id: '1', name: 'To Do', category: 'open' },
  { id: '3', name: 'In Progress', category: 'active' },
  { id: '5', name: 'Done', category: 'done' },
]

export function githubIssue(number: number, overrides: Partial<ProviderTask> = {}): ProviderTask {
  return {
    ref: { provider: 'github', id: `I_${number}` },
    kind: 'issue',
    reference: `acme/app#${number}`,
    url: `https://github.com/acme/app/issues/${number}`,
    title: `Issue ${number}`,
    body: '',
    state: { name: 'Open', category: 'open' },
    labels: [],
    writableFields: ['title', 'body', 'labels', 'assignee'],
    home: { provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number },
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

export function githubDraft(id: string, overrides: Partial<ProviderTask> = {}): ProviderTask {
  return {
    ref: { provider: 'github', id },
    kind: 'draft',
    url: null,
    title: `Draft ${id}`,
    body: '',
    state: { name: 'Todo', category: 'open' },
    labels: [],
    writableFields: ['title', 'body', 'assignee'],
    home: { provider: 'github', kind: 'draft', projectId: 'PVT_1', itemId: `PVTI_${id}` },
    updatedAt: 2_000,
    ...overrides,
  }
}

export function jiraIssue(number: number, overrides: Partial<ProviderTask> = {}): ProviderTask {
  return {
    ref: { provider: 'jira', cloudId: 'site', id: String(10_000 + number) },
    kind: 'issue',
    reference: `SOL-${number}`,
    url: `https://acme.atlassian.net/browse/SOL-${number}`,
    title: `Jira ${number}`,
    body: '',
    state: { name: 'To Do', category: 'open' },
    stateId: '1',
    labels: [],
    writableFields: ['title', 'body', 'labels', 'priority'],
    home: { provider: 'jira', cloudId: 'site', key: `SOL-${number}` },
    updatedAt: 2_000,
    ...overrides,
  }
}

/** A read of the repository source that lists these issues in their own column. */
export function repoRead(tasks: ProviderTask[], truncated = false): SourceRead {
  return {
    label: 'acme/app',
    columns: REPO_COLUMNS,
    writeState: null,
    items: tasks.map((task) => ({ task, columnId: task.state.category === 'done' ? 'closed' : 'open', itemId: null })),
    truncated,
  }
}

/** A read of the GitHub Project source: each task with the column the test names. */
export function boardRead(items: Array<{ task: ProviderTask; columnId: string | null }>): SourceRead {
  return {
    label: 'Roadmap',
    columns: BOARD_COLUMNS,
    writeState: { kind: 'github-project', projectId: 'PVT_1', statusFieldId: 'F_status' },
    items: items.map((item) => ({ ...item, itemId: `PVTI_${item.task.ref.id}` })),
    truncated: false,
  }
}

export function jiraRead(tasks: ProviderTask[]): SourceRead {
  return {
    label: 'SOL',
    columns: JIRA_COLUMNS,
    writeState: null,
    items: tasks.map((task) => ({ task, columnId: task.stateId ?? null, itemId: null })),
    truncated: false,
  }
}

function stateOf(category: TaskStatusCategory, provider: 'github' | 'jira'): Pick<ProviderTask, 'state' | 'stateId'> {
  if (provider === 'github') return { state: category === 'done' ? { name: 'Closed', category: 'done' } : { name: 'Open', category: 'open' } }
  const column = JIRA_COLUMNS.find((candidate) => candidate.category === category)!
  return { state: { name: column.name, category }, stateId: column.id }
}

export class FakeTaskProviders {
  /** The tasks as the provider holds them, by task key. */
  readonly tasks = new Map<string, ProviderTask>()
  readonly comments = new Map<string, ProviderComment[]>()
  /** What a read of each source answers, by source key. An `Error` is a read that fails. */
  readonly reads = new Map<string, SourceRead | Error>()
  /** Each call that reached a provider, in order: `read:<sourceKey>`, `update:<taskKey>`, ... */
  readonly calls: string[] = []
  /** While set, each provider call fails with it. */
  failure: Error | null = null
  /** While set, a source read waits for it: a test holds a read in flight. */
  readGate: Promise<void> | null = null
  /** File extensions the provider cannot hold. */
  unpublishable: string[] = []
  private created = 0

  /** Put tasks on the provider. */
  hold(...tasks: ProviderTask[]): void {
    for (const task of tasks) this.tasks.set(taskKey(task.ref), task)
  }

  /** Set what a read of a source answers, and put its tasks on the provider. */
  answer(source: TaskSource, read: SourceRead | Error): void {
    this.reads.set(taskSourceKey(source), read)
    if (!(read instanceof Error)) this.hold(...read.items.map((item) => item.task))
  }

  callsOf(prefix: string): string[] {
    return this.calls.filter((call) => call.startsWith(prefix))
  }

  private call(name: string): void {
    this.calls.push(name)
    if (this.failure) throw this.failure
  }

  private held(key: string): ProviderTask {
    const task = this.tasks.get(key)
    if (!task) throw Object.assign(new Error('Not Found'), { status: 404 })
    return task
  }

  private keyOf(home: ProviderTask['home']): string {
    for (const [key, task] of this.tasks) if (JSON.stringify(task.home) === JSON.stringify(home)) return key
    throw Object.assign(new Error('Not Found'), { status: 404 })
  }

  adapters(): TaskAdapters {
    const source = (kind: TaskSource['kind']): TaskSourceAdapter => ({
      kind,
      read: async (which) => {
        const sourceKey = taskSourceKey(which)
        this.calls.push(`read:${sourceKey}`)
        if (this.readGate) await this.readGate
        if (this.failure) throw this.failure
        const answer = this.reads.get(sourceKey)
        if (!answer) throw Object.assign(new Error('Not Found'), { status: 404 })
        if (answer instanceof Error) throw answer
        return answer
      },
      search: async (which, query) => {
        this.call(`search:${taskSourceKey(which)}:${query}`)
        return [...this.tasks.values()].filter((task) => task.title.toLowerCase().includes(query.toLowerCase()))
      },
      create: async ({ source: which, draft }): Promise<SourceItem> => {
        this.call(`create:${taskSourceKey(which)}`)
        const number = 900 + ++this.created
        const task = which.kind === 'github-project'
          ? githubDraft(`DI_${number}`, { title: draft.title, body: draft.body ?? '' })
          : which.kind === 'github-repo'
            ? githubIssue(number, { title: draft.title, body: draft.body ?? '', labels: draft.labels ?? [] })
            : jiraIssue(number, { title: draft.title, body: draft.body ?? '' })
        this.hold(task)
        const columnId = draft.columnId ?? (which.kind === 'github-repo' ? 'open' : which.kind === 'github-project' ? null : '1')
        return { task, columnId, itemId: which.kind === 'github-project' ? `PVTI_${task.ref.id}` : null }
      },
      move: async ({ source: which, home, columnId }) => {
        const key = this.keyOf(home)
        this.call(`move:${taskSourceKey(which)}:${key}:${columnId}`)
        if (which.kind === 'github-project') return null
        const columns = which.kind === 'github-repo' ? REPO_COLUMNS : JIRA_COLUMNS
        const category = columns.find((column) => column.id === columnId)?.category ?? 'open'
        const moved = { ...this.held(key), ...stateOf(category, which.kind === 'github-repo' ? 'github' : 'jira'), updatedAt: this.held(key).updatedAt + 1 }
        this.tasks.set(key, moved)
        return moved
      },
      assignees: async (which) => {
        this.call(`assignees:${taskSourceKey(which)}`)
        return [{ login: 'octocat' }]
      },
    })
    const provider = (id: 'github' | 'jira'): TaskProviderAdapter => ({
      id,
      fetch: async (ref) => {
        const key = taskKey(ref)
        this.call(`fetch:${key}`)
        return { task: this.held(key), comments: this.comments.get(key) ?? [], commentsTruncated: false }
      },
      update: async (home, patch) => {
        const key = this.keyOf(home)
        this.call(`update:${key}`)
        const before = this.held(key)
        const updated: ProviderTask = { ...before, updatedAt: before.updatedAt + 1 }
        if (patch.title !== undefined) updated.title = patch.title
        if (patch.body !== undefined) updated.body = patch.body
        if (patch.labels !== undefined) updated.labels = patch.labels
        if (patch.assignee !== undefined) updated.assignee = patch.assignee ?? undefined
        if (patch.priority !== undefined) updated.priority = patch.priority ?? undefined
        this.tasks.set(key, updated)
        return updated
      },
      setState: async (home, category) => {
        const key = this.keyOf(home)
        this.call(`setState:${key}:${category}`)
        const moved = { ...this.held(key), ...stateOf(category, id), updatedAt: this.held(key).updatedAt + 1 }
        this.tasks.set(key, moved)
        return moved
      },
      comment: async (home, body) => {
        const key = this.keyOf(home)
        this.call(`comment:${key}`)
        const held = this.comments.get(key) ?? []
        const comment = { id: `C_${key}_${held.length + 1}`, author: 'octocat', body, createdAt: 5_000 + held.length }
        this.comments.set(key, [...held, comment])
        return comment
      },
      assignees: async (home) => {
        this.call(`assignees:${this.keyOf(home)}`)
        return [{ login: 'octocat' }]
      },
      publishAssets: async (home, body) => {
        this.call(`publish:${this.keyOf(home)}`)
        return body.replace(/asset:\/\/\S+?(?=\))/g, 'https://provider.example/asset')
      },
      unpublishableAssets: (_home, body) => this.unpublishable.flatMap((extension) =>
        body.includes(`.${extension})`) ? [{ assetId: `x.${extension}`, extension, label: '', isImage: false }] : []),
      remove: async (home) => {
        const key = this.keyOf(home)
        this.call(`remove:${key}`)
        this.tasks.delete(key)
      },
    })
    const sources = new Map<TaskSource['kind'], TaskSourceAdapter>()
    const providers = { github: provider('github'), jira: provider('jira') }
    return {
      source: (kind) => {
        let adapter = sources.get(kind)
        if (!adapter) sources.set(kind, adapter = source(kind))
        return adapter
      },
      provider: (id) => providers[id],
    }
  }
}

/**
 * Put a copy of a task in the host's cache, as a provider read does. For a
 * test that needs a task to attach things to and is not about the provider.
 * Imported lazily: a database test sets its data directory before it loads
 * the server modules.
 */
export async function seedTask(task: ProviderTask = githubIssue(1)): Promise<import('@solus/contracts/task-types').Task> {
  const { storeProviderTask } = await import('@solus/server/data/tasks/task-cache')
  return storeProviderTask(task)
}
