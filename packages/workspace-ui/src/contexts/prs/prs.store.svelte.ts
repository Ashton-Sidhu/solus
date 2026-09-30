// Pull requests, keyed by project.
//
// Shared records, and the interest that asks PR sync on the host to keep them
// fresh. Nothing here polls. Every operation names a project first, because a
// pull request only means anything inside one:
//
//   prsStore.get(api, serverId, ctx).loadMore()      // this project's next page
//   prsStore.get(api, serverId, ctx).get(7).merge()  // one pull request in it
//
// How the user is *looking* at them — which project is on screen, how the list
// was left — is not here; that is `PrView`.

import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import type { PrFilter, PrInterest, PrSyncChange } from '@solus/contracts/providers'
import { projectScopeOf, worktreeProjectRoot, type IpcContext } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { detached, ProjectPrs, projectPrsKey } from './project-prs.svelte'
import { afterStartupTranscriptPaint } from '../workspace/startup-transcript'
import { linkedPrIdentity, latestPrObservation, type LinkedPr, type PrLink } from './linked-pr'
import { readPrListSnapshot, writePrListSnapshot } from '../../components/prs/lib/pr-list-memory'

/** One project to read. Carries the handle needed to create its entry. */
export interface PrProject {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
}

/** What one project's surfaces want PR sync to keep fresh, by surface. */
interface ProjectWants {
  project: ProjectPrs
  bySurface: Map<symbol, readonly PrInterest[]>
}

/** Heard for every `pr.changed` and every interest answer: the change, and
 *  the projects on that host that read its repository. */
type PrChangeListener = (change: PrSyncChange, projects: ProjectPrs[]) => void

export class PrsStore {
  private readonly byProject = new SvelteMap<string, ProjectPrs>()
  private readonly wants = new Map<string, ProjectWants>()
  private readonly unsent = new Set<ProjectWants>()
  private sending: Promise<void> | undefined
  private readonly listeners = new Set<PrChangeListener>()
  private stopListening: (() => void) | undefined

  constructor(
    private readonly deferBackground: () => Promise<void> = afterStartupTranscriptPaint,
  ) {}

  /**
   * Ask PR sync on the host to keep something fresh while a surface shows it
   * (docs/plans/pr-sync.md). Nothing here polls: the host answers what it
   * knows now, and what changes later arrives as `pr.changed`. All surfaces of
   * one project are sent as one set, and releasing the last one tells the host
   * to stop.
   */
  want(api: HostApi, serverId: string, ctx: IpcContext, interests: readonly PrInterest[]): () => void {
    const project = this.get(api, serverId, ctx)
    let wants = this.wants.get(project.key)
    if (!wants) {
      wants = { project, bySurface: new Map() }
      this.wants.set(project.key, wants)
    }
    const surface = Symbol('pr-interest')
    wants.bySurface.set(surface, detached(interests))
    this.listen()
    this.send(wants)
    const held = wants
    return () => {
      if (!held.bySurface.delete(surface)) return
      this.send(held)
    }
  }

  /** Hear what PR sync reports. The checks and needs-review stores file their
   *  parts of each change from here. */
  onChange(listener: PrChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Send a project's interest after the current task, so the surfaces that
   *  mount together cost one request. */
  private send(wants: ProjectWants): void {
    this.unsent.add(wants)
    this.sending ??= this.deferBackground().then(async () => {
      while (this.unsent.size) {
        const batch = [...this.unsent]
        this.unsent.clear()
        await Promise.all(batch.map((next) => this.sendNow(next)))
      }
    }).finally(() => { this.sending = undefined })
  }

  private async sendNow({ project, bySurface }: ProjectWants): Promise<void> {
    const byJson = new Map<string, PrInterest>()
    for (const interests of bySurface.values()) {
      for (const interest of interests) byJson.set(JSON.stringify(interest), interest)
    }
    if (!bySurface.size) this.wants.delete(project.key)
    try {
      const known = await project.hostApi.prSetInterest(detached(project.hostContext), [...byJson.values()])
      this.applyChange(project.serverId, known, project)
    } catch {
      // A project with no repository has nothing to keep fresh; a lost
      // connection sends again when it returns.
    }
  }

  /** One subscription for the whole workspace, taken with the first interest. */
  private listen(): void {
    if (this.stopListening) return
    const changed = subscribeAllHosts('pr.changed', (serverId, change) => this.applyChange(serverId, change))
    // A host forgets a connection's interest when it drops, so say it again.
    const reconnected = serverConnections.onStatusChange((serverId, status) => {
      if (status !== 'connected') return
      for (const wants of this.wants.values()) {
        if (wants.project.serverId === serverId) this.send(wants)
      }
    })
    this.stopListening = () => {
      changed()
      reconnected()
    }
  }

  /** File a change in every project on that host that reads its repository. */
  private applyChange(serverId: string, change: PrSyncChange, origin?: ProjectPrs): void {
    if (origin) origin.repositoryKey ??= change.repo
    const projects = [...this.byProject.values()].filter((project) =>
      project.serverId === serverId && project.repositoryKey === change.repo)
    for (const project of projects) {
      for (const pullRequest of change.pullRequests) project.absorbSynced(pullRequest)
    }
    for (const listener of this.listeners) listener(change, projects)
  }

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
    const pullRequest = latestPrObservation(live, 'snapshot' in link ? link.snapshot : undefined)
    return {
      ...identity,
      title: pullRequest?.title || identity.title,
      url: identity.url ?? pullRequest?.url ?? null,
      pullRequest,
      missing: link.missing === true && !live,
    }
  }

  /** Keep the pull requests these links name fresh while a surface shows
   *  them. Each link names its own repository; the caller supplies the host. */
  wantLinkedPrs(api: HostApi, serverId: string, ctx: IpcContext, links: readonly PrLink[]): () => void {
    const byScope = new Map<string, PrInterest[]>()
    for (const link of links) {
      const identity = linkedPrIdentity(link, projectScopeOf(ctx.session))
      if (!identity) continue
      const interests = byScope.get(identity.targetScope) ?? []
      interests.push({ kind: 'pull-request', number: identity.number })
      byScope.set(identity.targetScope, interests)
    }
    const releases = [...byScope].map(([scope, interests]) => this.want(api, serverId, {
      ...ctx,
      session: { ...ctx.session, projectPath: scope, workingDirectory: scope, gitContext: null },
    }, interests))
    return () => { for (const release of releases) release() }
  }

  get all(): ProjectPrs[] {
    return [...this.byProject.values()]
  }

  /**
   * Read every named project's first page — the workspace-wide inbox.
   *
   * One request per host, not per project: the host reads its projects side by
   * side and answers for all of them together, so each host's rows land in one
   * update instead of reordering the list as every project arrives. Each answer
   * is filed in that project's own entry. Projects not named here are dropped,
   * except those a surface is watching.
   */
  async listProjects(targets: PrProject[], filter: PrFilter, opts: { force?: boolean } = {}): Promise<void> {
    const named = new Set(targets.map((target) => projectPrsKey(target.serverId, target.ctx)))
    for (const key of this.byProject.keys()) {
      if (!named.has(key) && !this.wants.has(key)) this.byProject.delete(key)
    }
    const byHost = new Map<string, ProjectPrs[]>()
    for (const target of targets) {
      const project = this.get(target.api, target.serverId, target.ctx)
      // A project the host has already said has no git remote — a plain folder
      // — has nothing to list, and asking again on every refresh only spends a
      // host read. An explicit refresh still retries it, so `git remote add` is
      // one click from showing up.
      if (!opts.force && project.error?.kind === 'no-repository') continue
      const projects = byHost.get(target.serverId) ?? []
      projects.push(project)
      byHost.set(target.serverId, projects)
    }
    await Promise.all([...byHost.values()].map((projects) => this.listHost(projects, detached(filter), !!opts.force)))
  }

  /** One `prListProjects` for projects that share a host. The host also reads
   *  each project's authored and review-requested pull requests, so those
   *  sections are whole even when the first page is other people's work. */
  private async listHost(projects: ProjectPrs[], filter: PrFilter, force: boolean): Promise<void> {
    const reads = projects.map((project) => ({ project, token: project.beginListing(filter) }))
    try {
      if (force) await Promise.all(projects.map((project) => project.forgetListing(filter)))
      const [first] = projects
      const listings = await first.hostApi.prListProjects(
        detached(first.hostContext),
        projects.map((project) => project.projectScope),
        filter,
      )
      const byRoot = new Map(listings.map((listing) => [listing.projectRoot, listing]))
      for (const { project, token } of reads) {
        const listing = byRoot.get(project.projectScope)
        if (listing) project.acceptListing(token, filter, listing)
      }
    } catch (error) {
      for (const { project, token } of reads) project.failListing(token, error)
    } finally {
      for (const { project, token } of reads) project.endListing(token)
    }
  }

  /**
   * Read the list a page is showing: one project, or every project through
   * `listProjects` when `targets` is given.
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
    if (opts.targets) await this.listProjects(opts.targets, filter, opts.force ? { force: true } : {})
    else await this.listHost([scopes[0]], detached(filter), !!opts.force)
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
}

export { ProjectPrs, projectPrsKey, detached, type PrQuery } from './project-prs.svelte'
