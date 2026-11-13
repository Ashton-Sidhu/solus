// The person's task sources, as the task host last read them.
//
// Tasks belong to no project (docs/tasks.md). The sources are a personal
// setting, synced with the account, and the client sends them to one host: the
// task host (`taskHostId`). The host reads each source and says when a read
// ends (`tasks.sourcesChanged`). Nothing here polls. The tasks themselves are
// in `TasksStore`.

import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import type { TaskSource } from '@solus/contracts/task-sources'
import type { TaskSourceOptions, TaskSourceState } from '@solus/contracts/task-types'
import type { PersonalSettings } from '@solus/contracts/settings'
import { hosts } from '../hosts/hosts.svelte'

const SOURCES_CHANGED_DEBOUNCE_MS = 100

/** The part of the personal settings that names the person's task sources. */
export interface TaskSourceSettings {
  readonly values: Pick<PersonalSettings, 'taskSources'>
  onChange(listener: (change: { set: object; reset: readonly string[] }) => void): () => void
}

/**
 * The one host that the client asks for the person's tasks and sources: the
 * host of this device when it is connected and runs agents, else the primary
 * connection when it runs agents. Null when no such host is connected. Only a
 * host that runs agents has a provider connection to read GitHub and Jira; the
 * organization's Solus API holds attachments only.
 */
export function taskHostId(): string | null {
  const isReady = (serverId: string) =>
    serverConnections.connectedServerIds().includes(serverId)
    && serverConnections.readinessFor(serverId).readiness === 'ready'
    && hosts.hasExecution(serverId)
  const device = serverConnections.localServerId()
  if (device && isReady(device)) return device
  const primary = serverConnections.defaultServerId()
  return primary && isReady(primary) ? primary : null
}

export class TaskSourcesStore {
  /** The task host's last read of each of the person's sources. */
  sources = $state<TaskSourceState[]>([])
  /** Why the last read failed, or null. */
  error = $state<string | null>(null)
  /** What a person can choose as a source, or null until read. */
  options = $state<TaskSourceOptions | null>(null)
  optionsError = $state<string | null>(null)
  /** The task host of the last read: undefined before the first read ends,
   *  null when no task host was connected. */
  host = $state<string | null | undefined>(undefined)

  #settings: TaskSourceSettings | null = null
  #optionLoad: Promise<TaskSourceOptions | null> | null = null
  /** Bumped by each read, so an older answer never replaces a newer one. */
  #readGeneration = 0
  #changeTimer: ReturnType<typeof setTimeout> | null = null
  #pendingReads = $state(0)
  #isStarted = false

  /** Read again when the task host says its sources changed, and when a host
   *  that can be the task host becomes ready. */
  start(): void {
    if (this.#isStarted) return
    this.#isStarted = true
    subscribeAllHosts('tasks.sourcesChanged', (serverId) => {
      if (serverId !== taskHostId()) return
      // One refresh of several sources ends as several events.
      if (this.#changeTimer) clearTimeout(this.#changeTimer)
      this.#changeTimer = setTimeout(() => {
        this.#changeTimer = null
        void this.load()
      }, SOURCES_CHANGED_DEBOUNCE_MS)
    })
    serverConnections.onReadinessChange((_serverId, readiness) => {
      if (readiness === 'ready') void this.load()
    })
  }

  /** Follow the person's settings: the sources are read from them, and read
   *  again when they change. Returns the stop. */
  useSources(settings: TaskSourceSettings): () => void {
    this.#settings = settings
    const stop = settings.onChange((change) => {
      if ('taskSources' in change.set || change.reset.includes('taskSources')) void this.load()
    })
    return () => {
      stop()
      if (this.#settings === settings) this.#settings = null
    }
  }

  // --- Answers ------------------------------------------------------------

  /** The person's sources as their settings name them. Plain, so they cross IPC. */
  get configured(): TaskSource[] {
    // SAFETY: a snapshot keeps the value of the setting and drops its proxy only.
    return $state.snapshot(this.#settings?.values.taskSources ?? []) as TaskSource[]
  }

  /** True while a read is in flight, or while the host reads a source from its provider. */
  get refreshing(): boolean {
    return this.#pendingReads > 0 || this.sources.some((source) => source.refreshing)
  }

  /** A source as the task host last read it, to name a task's placement. */
  readonly sourceByKey: Map<string, TaskSourceState> = $derived(
    new Map(this.sources.map((source) => [source.sourceKey, source])),
  )

  // --- Reads --------------------------------------------------------------

  /** Read the person's sources on the task host. `force` is a person's
   *  refresh: the host reads every source from its provider again. */
  async load(opts: { refresh?: 'force' } = {}): Promise<void> {
    const generation = ++this.#readGeneration
    const serverId = taskHostId()
    const configured = this.configured
    if (!serverId || configured.length === 0) {
      this.sources = []
      this.error = null
      this.host = serverId
      return
    }
    this.#pendingReads++
    try {
      const answer = await serverConnections.apiFor(serverId)
        .tasksSources(configured, opts.refresh ? { refresh: opts.refresh } : undefined)
      if (this.#readGeneration !== generation) return
      this.sources = answer
      this.error = null
      this.host = serverId
    } catch (error) {
      if (this.#readGeneration !== generation) return
      // The last answer stays on screen: a host that fails one read did not lose the sources.
      this.error = error instanceof Error ? error.message : String(error)
      this.host = serverId
    } finally {
      this.#pendingReads--
    }
  }

  // --- Source setup -------------------------------------------------------

  /** Read the choices when the source setup opens. Each open reads again: a
   *  person connects GitHub or Jira in between. */
  loadOptions(): Promise<TaskSourceOptions | null> {
    if (this.#optionLoad) return this.#optionLoad
    const load = (async () => {
      try {
        const serverId = taskHostId()
        if (!serverId) throw new Error('No connected machine runs agents, so no machine can read GitHub or Jira.')
        const options = await serverConnections.apiFor(serverId).tasksSourceOptions()
        this.options = options
        this.optionsError = null
        return options
      } catch (error) {
        this.optionsError = error instanceof Error ? error.message : String(error)
        return null
      } finally {
        this.#optionLoad = null
      }
    })()
    this.#optionLoad = load
    return load
  }
}

export const taskSourcesStore = new TaskSourcesStore()
