import { taskSourceKey, type TaskSource } from '@solus/contracts/task-sources'
import type { TaskProjectSources, TaskSourceState } from '@solus/contracts/task-types'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'
import { loadProjectConfig, resolveProjectRoot } from '../../project-config/project-config'
import { captureActingScope, withActingScope, type ActingScope } from '../../vault/acting-scope'
import { classifyProviderFailure } from './providers/failures'
import { taskAdapters } from './providers/registry'
import { notifyTaskAssignments } from './task-assignment'
import { storeSourceRead } from './task-cache'
import {
  ensureTaskSource,
  loadTaskSourceAccess,
  loadTaskSources,
  recordTaskSourceAccess,
  taskSourceLabel,
  type StoredTaskSource,
  type TaskSourceAccess,
} from './task-source-store'
import { emitChanged } from './task-store'

/**
 * The one owner of the freshness of task sources
 * (docs/plans/provider-owned-tasks.md §5). A client says which projects it
 * shows (`tasksSources`); the host reads each source that is not fresh, one
 * read at a time for each source, and reads the wanted sources again on a
 * timer. Two projects that list one source cause one read. A read runs with
 * the credentials of the person who asked, and only a read that the provider
 * answered lets that person see the tasks of the source.
 */

const log = createLogger('main', 'task-sources')

/** A source read newer than this is fresh: a `stale` refresh does not read it again. */
export const SOURCE_FRESH_MS = 30_000
/** How often the host reads the wanted sources again. */
export const SOURCE_POLL_MS = 5 * 60_000
/** How long a source stays wanted after the last client asked for it. */
export const SOURCE_WANTED_MS = 15 * 60_000
/** With more changed tasks than this, one unnamed change tells clients to read the whole list. */
const MAX_NAMED_CHANGES = 5

/** The task sources a project lists in its config, and where a new task goes. */
export interface ProjectTaskSources {
  sources: TaskSource[]
  /** Absent when the project has no source. */
  defaultSourceKey?: string
}

/** The sources of the project that holds `cwd`. A path from a client is not a real path, so it is resolved first. */
export async function projectTaskSources(cwd: string): Promise<ProjectTaskSources> {
  const config = await loadProjectConfig(resolveProjectRoot(resolveHomePath(cwd)))
  const sources = config?.taskSources ?? []
  if (!sources.length) return { sources: [] }
  return { sources, defaultSourceKey: config?.defaultTaskSource ?? taskSourceKey(sources[0]) }
}

interface SourceWant {
  source: TaskSource
  personKey: string
  /** Whose credentials a later read of the timer uses. Null outside a request. */
  scope: ActingScope | null
  wantedAt: number
}

/** The last want of each person, for each source. */
const wants = new Map<string, Map<string, SourceWant>>()
/** The one read in flight for each source. */
const reads = new Map<string, Promise<void>>()
/** The people who asked while another person's read was in flight, and have no access yet. */
const waiting = new Map<string, Map<string, TaskSource>>()
/** When each person's last read of a source started, so a source that fails is not read on each call. */
const attempts = new Map<string, number>()
const changeListeners = new Set<(sourceKeys: string[]) => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null

function attemptKey(personKey: string, sourceKey: string): string {
  return `${personKey}\0${sourceKey}`
}

/** Hear each end of a source read: what `tasks.sourcesChanged` carries. */
export function onTaskSourcesChanged(listener: (sourceKeys: string[]) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function announce(sourceKeys: string[]): void {
  for (const listener of changeListeners) {
    try {
      listener(sourceKeys)
    } catch (error) {
      log.error('task_sources_changed_listener_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function sourceState(
  sourceKey: string,
  source: TaskSource,
  stored: StoredTaskSource | undefined,
  access: TaskSourceAccess | undefined,
): TaskSourceState {
  // The cache is shared, but a person sees what a source holds only after their own connection read it.
  const visible = stored && access?.checkedAt != null && stored.fetchedAt !== null ? stored : null
  const state: TaskSourceState = {
    sourceKey,
    source,
    label: visible?.label ?? taskSourceLabel(source),
    columns: visible?.columns ?? [],
    health: access?.health ?? 'ok',
  }
  if (access?.message) state.message = access.message
  if (visible?.fetchedAt != null) state.fetchedAt = visible.fetchedAt
  if (visible?.truncated) state.truncated = true
  if (reads.has(sourceKey)) state.refreshing = true
  return state
}

/**
 * The task sources of each project, as the host last read them for one person.
 * The call also says that the person wants these sources: the host reads each
 * one that is older than `SOURCE_FRESH_MS`, or every one with `refresh:
 * 'force'`, and does not wait for the reads. A source that this person's
 * connection never read is answered with no columns and `refreshing`; the
 * read that this call starts gives its `health`.
 */
export async function tasksSources(
  cwds: readonly string[],
  personKey: string,
  options: { refresh?: 'stale' | 'force'; now?: number } = {},
): Promise<Record<string, TaskProjectSources>> {
  const now = options.now ?? Date.now()
  const scope = captureActingScope()
  const projects = new Map<string, ProjectTaskSources>()
  const listed = new Map<string, TaskSource>()
  for (const cwd of cwds) {
    const project = await projectTaskSources(cwd)
    projects.set(cwd, project)
    for (const source of project.sources) listed.set(taskSourceKey(source), source)
  }
  const sourceKeys = [...listed.keys()]
  for (const [sourceKey, source] of listed) {
    await ensureTaskSource(sourceKey, source)
    let wanted = wants.get(sourceKey)
    if (!wanted) wants.set(sourceKey, wanted = new Map())
    wanted.set(personKey, { source, personKey, scope, wantedAt: now })
  }
  const stored = await loadTaskSources(sourceKeys)
  const access = await loadTaskSourceAccess(personKey, sourceKeys)
  for (const [sourceKey, source] of listed) {
    const hasRead = access.get(sourceKey)?.checkedAt != null
    const lastRead = Math.max(attempts.get(attemptKey(personKey, sourceKey)) ?? 0, hasRead ? stored.get(sourceKey)?.fetchedAt ?? 0 : 0)
    if (options.refresh === 'force' || now - lastRead >= SOURCE_FRESH_MS) void readTaskSource(source, personKey, now)
  }
  const answer: Record<string, TaskProjectSources> = {}
  for (const [cwd, project] of projects) {
    const sources: TaskProjectSources = {
      sources: project.sources.map((source) => {
        const sourceKey = taskSourceKey(source)
        return sourceState(sourceKey, source, stored.get(sourceKey), access.get(sourceKey))
      }),
    }
    if (project.defaultSourceKey) sources.defaultSourceKey = project.defaultSourceKey
    answer[cwd] = sources
  }
  return answer
}

/**
 * Read one source from its provider with the acting person's credentials, and
 * write the answer over the cache. One read is in flight for each source: a
 * second caller gets the same read. A person with no access who asks during
 * another person's read gets their own read after it, because only their own
 * connection can give them access. A failed read keeps the tasks the host had.
 * Never rejects: the result is the person's `health` of the source.
 */
export function readTaskSource(source: TaskSource, personKey: string, now = Date.now()): Promise<void> {
  const sourceKey = taskSourceKey(source)
  const inFlight = reads.get(sourceKey)
  if (inFlight) {
    let queue = waiting.get(sourceKey)
    if (!queue) waiting.set(sourceKey, queue = new Map())
    queue.set(personKey, source)
    return inFlight
  }
  attempts.set(attemptKey(personKey, sourceKey), now)
  const read = runSourceRead(sourceKey, source, personKey).finally(() => {
    reads.delete(sourceKey)
    announce([sourceKey])
    void readForWaiting(sourceKey)
  })
  reads.set(sourceKey, read)
  return read
}

async function runSourceRead(sourceKey: string, source: TaskSource, personKey: string): Promise<void> {
  try {
    const hadAccess = (await loadTaskSourceAccess(personKey, [sourceKey])).get(sourceKey)?.checkedAt != null
    const answer = await taskAdapters().source(source.kind).read(source)
    const { changed, assigned } = await storeSourceRead(source, answer)
    await recordTaskSourceAccess(personKey, sourceKey, { checkedAt: Date.now() })
    await notifyTaskAssignments(assigned, personKey).catch((error) => {
      log.warn('task_assignment_notify_failed', { sourceKey, error: error instanceof Error ? error.message : String(error) })
    })
    // A person who sees the source for the first time sees each of its tasks for the first time.
    if (!hadAccess || changed.length > MAX_NAMED_CHANGES) emitChanged()
    else for (const taskId of changed) emitChanged(taskId)
  } catch (error) {
    const failure = classifyProviderFailure(error)
    log.warn('task_source_read_failed', { sourceKey, health: failure.health, error: failure.message })
    await recordTaskSourceAccess(personKey, sourceKey, failure).catch((storeError) => {
      log.error('task_source_access_write_failed', { sourceKey, error: storeError instanceof Error ? storeError.message : String(storeError) })
    })
  }
}

/** Give each person who waited for another person's read their own read, when they still have no access. */
async function readForWaiting(sourceKey: string): Promise<void> {
  const queue = waiting.get(sourceKey)
  waiting.delete(sourceKey)
  if (!queue) return
  for (const [personKey, source] of queue) {
    const hasRead = (await loadTaskSourceAccess(personKey, [sourceKey])).get(sourceKey)?.checkedAt != null
    if (hasRead) continue
    const scope = wants.get(sourceKey)?.get(personKey)?.scope ?? null
    await (scope ? withActingScope(scope, () => readTaskSource(source, personKey)) : readTaskSource(source, personKey))
  }
}

/**
 * Read again each source that a client asked for in the last
 * `SOURCE_WANTED_MS`, with the credentials of the person who asked last.
 * The timer calls this; a test calls it with its own clock.
 */
export async function readWantedTaskSources(now = Date.now()): Promise<void> {
  const pending: Promise<void>[] = []
  for (const [sourceKey, wanted] of wants) {
    for (const [personKey, want] of wanted) if (now - want.wantedAt > SOURCE_WANTED_MS) wanted.delete(personKey)
    if (!wanted.size) {
      wants.delete(sourceKey)
      continue
    }
    const latest = [...wanted.values()].reduce((left, right) => right.wantedAt > left.wantedAt ? right : left)
    const read = () => readTaskSource(latest.source, latest.personKey, now)
    pending.push(latest.scope ? withActingScope(latest.scope, read) : read())
  }
  await Promise.all(pending)
}

/** Start the timer that keeps the wanted sources fresh. It does not keep the process alive. */
export function startTaskSourcePolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => void readWantedTaskSources(), SOURCE_POLL_MS)
  pollTimer.unref?.()
}

/** Stop the timer, at shutdown. */
export function stopTaskSourcePolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** Tests only: wait until no source read is in flight, the reads for waiting people included. */
export async function taskSourceReadsEnd(): Promise<void> {
  while (reads.size || waiting.size) {
    await Promise.all(reads.values())
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Tests only: forget every want, attempt and queued read. */
export function resetTaskSourcesForTests(): void {
  stopTaskSourcePolling()
  wants.clear()
  waiting.clear()
  attempts.clear()
  reads.clear()
}
