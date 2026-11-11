// The task sources of each project, as each host last read them.
//
// Loaded like the pull request list (docs/pull-request-list.md): one
// `tasksSources` call per host for all its projects, and the host says when a
// read ends (`tasks.sourcesChanged`). Nothing here polls. The tasks themselves
// are in `TasksStore`; a source says which of them a project shows.

import { SvelteMap } from 'svelte/reactivity'
import { hostKey, splitHostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import type { TaskProjectSources, TaskSourceOptions, TaskSourceState } from '@solus/contracts/task-types'
import { hosts } from '../hosts/hosts.svelte'
import { projectsStore } from '../projects/projects.store.svelte'
import { mergeProjectSources } from './task-projects'

const SOURCES_CHANGED_DEBOUNCE_MS = 100

export class TaskSourcesStore {
  /** Each checkout's answer, keyed by `hostKey(serverId, cwd)`. */
  private readonly sourcesByCheckout = new SvelteMap<string, TaskProjectSources>()
  private readonly errorByHost = new SvelteMap<string, string>()
  private readonly optionsByCheckout = new SvelteMap<string, TaskSourceOptions>()
  private readonly optionsErrorByCheckout = new SvelteMap<string, string>()
  private readonly optionLoads = new Map<string, Promise<TaskSourceOptions | null>>()
  /** Folders a surface asked for that the host's project list does not hold. */
  private readonly extraCwdsByHost = new Map<string, Set<string>>()
  /** Bumped by each read of a host, so an older answer never replaces a newer one. */
  private readonly readGenerations = new Map<string, number>()
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingReads = $state(0)
  private isStarted = false

  /** Read every host again when it reconnects and when it says its sources changed. */
  start(): void {
    if (this.isStarted) return
    this.isStarted = true
    subscribeAllHosts('tasks.sourcesChanged', (serverId) => {
      // One refresh of several sources ends as several events.
      clearTimeout(this.changeTimers.get(serverId))
      this.changeTimers.set(serverId, setTimeout(() => {
        this.changeTimers.delete(serverId)
        void this.loadHost(serverId)
      }, SOURCES_CHANGED_DEBOUNCE_MS))
    })
    serverConnections.onReadinessChange((serverId, readiness) => {
      if (readiness === 'ready') void this.loadHost(serverConnections.resolveId(serverId))
    })
    subscribeAllHosts('projects.changed', (serverId) => void this.loadHost(serverId))
  }

  // --- Answers ------------------------------------------------------------

  /** True while a read is in flight, or while a host reads a source from its provider. */
  get refreshing(): boolean {
    if (this.pendingReads > 0) return true
    for (const answer of this.sourcesByCheckout.values()) {
      if (answer.sources.some((source) => source.refreshing)) return true
    }
    return false
  }

  /** One checkout's sources, or null until its host answers. */
  sourcesFor(serverId: string | null | undefined, cwd: string | null | undefined): TaskProjectSources | null {
    return serverId && cwd ? (this.sourcesByCheckout.get(hostKey(serverId, cwd)) ?? null) : null
  }

  /** Why the last read of a host failed, or null. */
  errorFor(serverId: string | null | undefined): string | null {
    return serverId ? (this.errorByHost.get(serverId) ?? null) : null
  }

  /** The sources of one project across its checkouts, each once. */
  sourcesOfProject(projectKey: string | null | undefined): TaskSourceState[] {
    if (!projectKey) return []
    return mergeProjectSources(this.answersOf(projectKey))
  }

  /** The source keys of each project that has a source. */
  readonly sourceKeysByProject: Map<string, Set<string>> = $derived.by(() => {
    const grouped = new Map<string, Set<string>>()
    for (const [key, answer] of this.sourcesByCheckout) {
      if (answer.sources.length === 0) continue
      const { serverId, path } = splitHostKey(key)
      const projectKey = projectsStore.projectKeyFor(serverId, path)
      let sourceKeys = grouped.get(projectKey)
      if (!sourceKeys) grouped.set(projectKey, (sourceKeys = new Set()))
      for (const source of answer.sources) sourceKeys.add(source.sourceKey)
    }
    return grouped
  })

  /** The projects that list each source. One source can be in many projects. */
  readonly projectKeysBySource: Map<string, string[]> = $derived.by(() => {
    const grouped = new Map<string, string[]>()
    for (const [projectKey, sourceKeys] of this.sourceKeysByProject) {
      for (const sourceKey of sourceKeys) {
        const projectKeys = grouped.get(sourceKey)
        if (projectKeys) projectKeys.push(projectKey)
        else grouped.set(sourceKey, [projectKey])
      }
    }
    return grouped
  })

  /** A source as some host last read it, to name a task's placement. */
  readonly sourceByKey: Map<string, TaskSourceState> = $derived(
    new Map(mergeProjectSources([...this.sourcesByCheckout.values()]).map((source) => [source.sourceKey, source])),
  )

  /** The checkout that a write for a project's source goes to: the first
   *  checkout of the project, on a connected host, that lists the source. */
  checkoutForSource(projectKey: string, sourceKey: string): { serverId: string; cwd: string } | null {
    for (const checkout of projectsStore.checkoutsOf(projectKey)) {
      if (serverConnections.readinessFor(checkout.serverId).readiness !== 'ready') continue
      const answer = this.sourcesFor(checkout.serverId, checkout.projectRoot)
      if (answer?.sources.some((source) => source.sourceKey === sourceKey)) {
        return { serverId: checkout.serverId, cwd: checkout.projectRoot }
      }
    }
    return null
  }

  private answersOf(projectKey: string): TaskProjectSources[] {
    const answers: TaskProjectSources[] = []
    for (const [key, answer] of this.sourcesByCheckout) {
      const { serverId, path } = splitHostKey(key)
      if (projectsStore.projectKeyFor(serverId, path) === projectKey) answers.push(answer)
    }
    return answers
  }

  // --- Reads --------------------------------------------------------------

  /** Read the sources of every connected host that runs projects. `force` is a
   *  person's refresh: each host reads every source from its provider again. */
  async load(opts: { refresh?: 'force' } = {}): Promise<void> {
    const serverIds = serverConnections.connectedServerIds().filter(
      (serverId) => serverConnections.readinessFor(serverId).readiness === 'ready',
    )
    await Promise.all(serverIds.map((serverId) => this.loadHost(serverId, opts)))
  }

  /** One request for all the projects of one host. `cwd` adds a folder that the
   *  host's project list may not hold, such as the one a page is scoped to. */
  async loadHost(serverId: string, opts: { refresh?: 'force'; cwd?: string } = {}): Promise<void> {
    // Only a host that runs projects has a project config and a provider connection.
    if (!hosts.hasExecution(serverId)) return
    if (opts.cwd) {
      const extra = this.extraCwdsByHost.get(serverId)
      if (extra) extra.add(opts.cwd)
      else this.extraCwdsByHost.set(serverId, new Set([opts.cwd]))
    }
    const cwds = [...new Set([
      ...projectsStore.projectsFor(serverId).map((project) => project.path),
      ...(this.extraCwdsByHost.get(serverId) ?? []),
    ])]
    if (cwds.length === 0) return
    const generation = (this.readGenerations.get(serverId) ?? 0) + 1
    this.readGenerations.set(serverId, generation)
    this.pendingReads++
    try {
      const answer = await serverConnections.apiFor(serverId)
        .tasksSources(cwds, opts.refresh ? { refresh: opts.refresh } : undefined)
      if (this.readGenerations.get(serverId) !== generation) return
      this.errorByHost.delete(serverId)
      const answered = new Set<string>()
      for (const [cwd, sources] of Object.entries(answer)) {
        const key = hostKey(serverId, cwd)
        answered.add(key)
        this.sourcesByCheckout.set(key, sources)
      }
      for (const key of this.sourcesByCheckout.keys()) {
        if (splitHostKey(key).serverId === serverId && !answered.has(key)) this.sourcesByCheckout.delete(key)
      }
    } catch (error) {
      if (this.readGenerations.get(serverId) !== generation) return
      // The last answer stays on screen: a host that fails one read did not lose its sources.
      this.errorByHost.set(serverId, error instanceof Error ? error.message : String(error))
    } finally {
      this.pendingReads--
    }
  }

  // --- Source setup -------------------------------------------------------

  /** What a person can choose as a source for one project, or null until read. */
  optionsFor(serverId: string | null | undefined, cwd: string | null | undefined): TaskSourceOptions | null {
    return serverId && cwd ? (this.optionsByCheckout.get(hostKey(serverId, cwd)) ?? null) : null
  }

  optionsErrorFor(serverId: string | null | undefined, cwd: string | null | undefined): string | null {
    return serverId && cwd ? (this.optionsErrorByCheckout.get(hostKey(serverId, cwd)) ?? null) : null
  }

  /** Read the choices when the source setup opens. Each open reads again: a
   *  person connects GitHub or Jira in between. */
  loadOptions(serverId: string, cwd: string): Promise<TaskSourceOptions | null> {
    const key = hostKey(serverId, cwd)
    const pending = this.optionLoads.get(key)
    if (pending) return pending
    const load = (async () => {
      try {
        const options = await serverConnections.apiFor(serverId).tasksSourceOptions(cwd)
        this.optionsByCheckout.set(key, options)
        this.optionsErrorByCheckout.delete(key)
        return options
      } catch (error) {
        this.optionsErrorByCheckout.set(key, error instanceof Error ? error.message : String(error))
        return null
      } finally {
        this.optionLoads.delete(key)
      }
    })()
    this.optionLoads.set(key, load)
    return load
  }
}

export const taskSourcesStore = new TaskSourcesStore()
