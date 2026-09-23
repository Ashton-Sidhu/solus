// Pull requests, keyed by project.
//
// Shared records and background refresh ownership. Every operation names a project first, because a pull
// request only means anything inside one:
//
//   prsStore.get(api, serverId, ctx).list()          // this project's rows
//   prsStore.get(api, serverId, ctx).get(7).merge()  // one pull request in it
//
// How the user is *looking* at them — which project is on screen, how the list
// was left — is not here; that is `PrView`.

import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import type { PrFilter } from '@solus/contracts/providers'
import type { TaskPrSnapshot } from '@solus/contracts/task-types'
import { projectScopeOf, worktreeProjectRoot, type IpcContext } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { ProjectPrs, projectPrsKey, type PrList } from './project-prs.svelte'
import { afterStartupTranscriptPaint } from '../workspace/startup-transcript'
import { linkedPrIdentity, latestPrObservation, type LinkedPr, type PrLink } from './linked-pr'
import { readPrListSnapshot, writePrListSnapshot } from '../../components/prs/lib/pr-list-memory'

export interface PrInterest {
  /** Linked records must be recovered even when absent from the list page. */
  linkedNumbers?: readonly number[]
  branches?: readonly string[]
  /** Saved links to enrich from the shared list; never a demand for details. */
  numbers?: readonly number[]
  /** Visible merge controls need detail fields even if the list knows the PR. */
  details?: readonly number[]
}

interface PrObserver {
  project: ProjectPrs
  interest: PrInterest
  changed?: () => void | Promise<void>
}

function listenForPrRefresh(refresh: () => void): () => void {
  const visibleRefresh = () => {
    if (document.visibilityState === 'visible') refresh()
  }
  const interval = window.setInterval(visibleRefresh, 60_000)
  window.addEventListener('focus', visibleRefresh)
  return () => {
    window.clearInterval(interval)
    window.removeEventListener('focus', visibleRefresh)
  }
}

/** How many projects are read at once. Each is a host round trip that spends
 *  nearly all its time waiting, so the useful ceiling is well above the core
 *  count; four keeps a large workspace from opening a burst of requests. */
const DEFAULT_CONCURRENCY = 4

/** One project to read. Carries the handle needed to create its entry. */
export interface PrProject {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
}

export class PrsStore {
  private readonly byProject = new SvelteMap<string, ProjectPrs>()
  private readonly linkedSnapshots = new SvelteMap<string, TaskPrSnapshot>()
  private readonly observers = new Set<PrObserver>()
  private readonly pending = new Set<ProjectPrs>()
  private draining: Promise<void> | undefined
  private subscriptions = 0
  private stopSubscriptions: (() => void) | undefined
  private stopRefresh: (() => void) | undefined

  constructor(
    private readonly deferBackground: () => Promise<void> = afterStartupTranscriptPaint,
    private readonly listenForRefresh: (refresh: () => void) => () => void = listenForPrRefresh,
  ) {}

  /** Surfaces declare interest; only this store schedules background reads.
   * Removing a surface removes its interest, including work not started yet. */
  watch(project: ProjectPrs, interest: PrInterest, changed?: () => void | Promise<void>): () => void {
    const observer = { project, interest, changed }
    this.observers.add(observer)
    const release = this.subscribeLifecycleChanges()
    this.stopRefresh ??= this.listenForRefresh(() => {
      for (const { project: target } of this.observers) this.enqueue(target)
    })
    this.enqueue(project)
    return () => {
      if (!this.observers.delete(observer)) return
      if (!this.observers.size) {
        this.stopRefresh?.()
        this.stopRefresh = undefined
      }
      release()
    }
  }

  private enqueue(project: ProjectPrs): void {
    if (![...this.observers].some((observer) => observer.project === project)) return
    this.pending.add(project)
    if (this.draining) return
    this.draining = this.deferBackground().then(async () => {
      while (this.pending.size) {
        const projects = [...this.pending].slice(0, DEFAULT_CONCURRENCY)
        for (const target of projects) this.pending.delete(target)
        await Promise.all(projects.map((target) => this.refreshObserved(target)))
      }
    }).finally(() => {
      this.draining = undefined
      const next = this.pending.values().next().value
      if (next) this.enqueue(next)
    })
  }

  private async refreshObserved(project: ProjectPrs): Promise<void> {
    const observers = [...this.observers].filter((observer) => observer.project === project)
    if (!observers.length) return
    const numbers = [...new Set(observers.flatMap(({ interest }) => [...interest.numbers ?? []]))]
    const branches = [...new Set(observers.flatMap(({ interest }) => [...interest.branches ?? []]))]
    const details = [...new Set(observers.flatMap(({ interest }) => [...interest.details ?? []]))]
    const linkedNumbers = [...new Set(observers.flatMap(({ interest }) => [...interest.linkedNumbers ?? []]))]
    try {
      if (!await project.refreshObserved(numbers, branches, details, linkedNumbers)) return
      for (const observer of observers) {
        if (this.observers.has(observer)) await observer.changed?.()
      }
    } catch {
      // Keep known records; focus, reconnect and the next poll can retry.
    }
  }

  /** Bumped on every `listAll`; a project's write is dropped if the generation
   *  it began under is no longer current — the guard against a slow host
   *  landing after a newer refresh has begun. */
  private generation = 0

  /**
   * This project's pull requests, created on first mention.
   *
   * The caller's `api` and `ctx` are adopted on the way through: a review opened
   * from the project switcher reads against a different project than the tab it
   * sits in, and the caller is what knows which.
   */
  get(api: HostApi, serverId: string, ctx: IpcContext): ProjectPrs {
    const key = projectPrsKey(serverId, ctx)
    const existing = this.byProject.get(key)
    if (existing) {
      existing.reachThrough(api, ctx)
      return existing
    }
    const created = new ProjectPrs(api, serverId, ctx, worktreeProjectRoot(projectScopeOf(ctx.session)))
    this.byProject.set(key, created)
    return created
  }

  /**
   * The project at this key, or null.
   *
   * For surfaces that hold identity but no host handle — the git rail, a task
   * row — and so cannot create one. A null answer means "nothing has read this
   * project yet", which those surfaces render as absence.
   */
  at(serverId: string | null | undefined, projectScope: string | null | undefined): ProjectPrs | null {
    if (!serverId || !projectScope) return null
    return this.byProject.get(hostKey(serverId, worktreeProjectRoot(projectScope))) ?? null
  }

  /** Read a link without choosing a repository or starting work during render. */
  linkedPr(serverId: string | null | undefined, link: PrLink, fallbackScope: string | null): LinkedPr | null {
    const identity = linkedPrIdentity(link, fallbackScope)
    if (!identity) return null
    const live = this.at(serverId, identity.targetScope)?.prFor(identity.number)
    const cached = serverId ? this.linkedSnapshots.get(hostKey(serverId, identity.key)) : undefined
    const saved = latestPrObservation(cached, 'snapshot' in link ? link.snapshot : undefined)
    const pullRequest = latestPrObservation(live, saved)
    return {
      ...identity,
      title: pullRequest?.title || identity.title,
      url: identity.url ?? pullRequest?.url ?? null,
      pullRequest,
    }
  }

  /** Own identity, batching and refresh for every surface displaying links.
   * The caller supplies its host; the active project's branch is never inherited. */
  watchLinkedPrs(api: HostApi, serverId: string, ctx: IpcContext, links: readonly PrLink[]): () => void {
    const groups = new Map<string, Set<number>>()
    for (const link of links) {
      const identity = linkedPrIdentity(link, projectScopeOf(ctx.session))
      if (!identity) continue
      if ('snapshot' in link && link.snapshot) {
        const key = hostKey(serverId, identity.key)
        const previous = this.linkedSnapshots.get(key)
        if (!previous || Date.parse(link.snapshot.updatedAt) > Date.parse(previous.updatedAt)) {
          this.linkedSnapshots.set(key, link.snapshot)
        }
      }
      const numbers = groups.get(identity.targetScope) ?? new Set<number>()
      numbers.add(identity.number)
      groups.set(identity.targetScope, numbers)
    }
    const releases = [...groups].map(([scope, numbers]) => {
      const scoped = {
        ...ctx,
        session: { ...ctx.session, projectPath: scope, workingDirectory: scope, gitContext: null },
      }
      return this.watch(this.get(api, serverId, scoped), { linkedNumbers: [...numbers] })
    })
    return () => { for (const release of releases) release() }
  }

  get all(): ProjectPrs[] {
    return [...this.byProject.values()]
  }

  /**
   * Read several projects at once, in parallel — the workspace-wide inbox.
   *
   * Each lands in its own entry through the same `list`, so a project already
   * open costs nothing. Projects not named here are dropped, except `keep` —
   * the page's own project, which must not lose its rows because the inbox
   * stopped naming it.
   */
  async listAll(
    targets: PrProject[],
    filter: PrFilter,
    opts: { force?: boolean; concurrency?: number; keep?: string } = {},
  ): Promise<void> {
    const generation = ++this.generation
    const named = new Set(targets.map((target) => projectPrsKey(target.serverId, target.ctx)))
    for (const key of this.byProject.keys()) {
      if (!named.has(key) && key !== opts.keep
        && ![...this.observers].some(({ project }) => project.key === key)) this.byProject.delete(key)
    }
    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < targets.length) {
        const target = targets[index++]
        if (generation !== this.generation) return
        const project = this.get(target.api, target.serverId, target.ctx)
        // A project the host has already said has no git remote — a plain
        // folder — has nothing to list, and asking again on every refresh only
        // spends a worker slot a real repository could use. An explicit refresh
        // still retries it, so `git remote add` is one click from showing up.
        if (!opts.force && project.error?.kind === 'no-repository') continue
        const read: PrList = { filter }
        if (opts.force !== undefined) read.force = opts.force
        await project.list(read, () => generation === this.generation)
        if (generation !== this.generation) return
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  }

  /**
   * Read the list a page is showing: one project, or every project through
   * `listAll` when `targets` is given.
   *
   * An unsearched read first paints the list remembered from the last visit
   * under `memoryKey` into any project that has nothing yet, and remembers its
   * own answer when it lands. A search is neither painted from memory nor
   * remembered — the next visit starts from the unsearched list.
   */
  async readPage(
    scopes: ProjectPrs[],
    filter: PrFilter,
    opts: { memoryKey: string; force?: boolean; targets?: PrProject[] },
  ): Promise<void> {
    if (scopes.length === 0) return
    const state = filter.state ?? 'open'
    if (!filter.query) {
      const remembered = readPrListSnapshot(opts.memoryKey, state)
      for (const scope of scopes) {
        const entry = remembered?.projects.find(
          (project) => project.serverId === scope.serverId && project.projectRoot === scope.projectScope,
        )
        if (entry) scope.showCached(entry.items)
      }
    }
    if (opts.targets) await this.listAll(opts.targets, filter, opts.force ? { force: true } : {})
    else await scopes[0].list(opts.force ? { filter, force: true } : { filter })
    const answered = scopes.filter((scope) => scope.loaded && !scope.error && !scope.filter.query)
    if (filter.query || answered.length === 0) return
    writePrListSnapshot(opts.memoryKey, {
      state,
      savedAt: Date.now(),
      projects: answered.map((scope) => ({
        serverId: scope.serverId,
        projectRoot: scope.projectScope,
        items: scope.items,
      })),
    })
  }

  /** A lifecycle change anywhere reaches the project holding that pull request.
   *  Wired once, for the whole workspace. */
  subscribeLifecycleChanges(): () => void {
    if (this.subscriptions++ === 0) this.startSubscriptions()
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.subscriptions === 0) this.stopSubscriptions?.()
    }
  }

  private startSubscriptions(): void {
    const changed = subscribeAllHosts('pr.lifecycleChanged', (serverId, event) => {
      const { host, owner, repo } = event.detail.baseRepo
      const projects = new Set([
        this.at(serverId, event.projectRoot),
        this.at(serverId, `${host}/${owner}/${repo}`.toLowerCase()),
      ])
      for (const project of projects) {
        if (!project) continue
        project.applyPullRequest(event.detail)
        this.enqueue(project)
      }
    })
    const invalidated = subscribeAllHosts('prs.invalidated', (serverId, { projectRoot }) => {
      const project = this.at(serverId, projectRoot)
      project?.forgetAll()
      if (project) this.enqueue(project)
    })
    const reconnected = serverConnections.onStatusChange((serverId, status) => {
      if (status !== 'connected') return
      for (const project of this.byProject.values()) {
        if (project.serverId !== serverId) continue
        project.forgetAll()
        this.enqueue(project)
      }
    })
    this.stopSubscriptions = () => {
      changed()
      invalidated()
      reconnected()
    }
  }
}

export { ProjectPrs, projectPrsKey, detached, type PrList, type PrQuery } from './project-prs.svelte'
