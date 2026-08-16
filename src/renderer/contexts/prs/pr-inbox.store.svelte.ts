import type { PrFilter, PrListPage, PullRequestSummary } from '../../../shared/providers'
import type { IpcContext } from '../../../shared/types'
import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'
import type { PrsStore } from './prs.store.svelte'
import { prSurfaceError, type PrSurfaceError } from '../../components/prs/lib/pr-surface-error'

/** One project the workspace-wide inbox is reading. */
export interface PrInboxProject {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
}

interface ProjectPrState {
  serverId: string
  projectRoot: string
  label: string
  api: HostApi
  ctx: IpcContext
  /** Last successful page. Kept across a failed refresh so one project's error
   *  never blanks data that was already on screen. */
  items: PullRequestSummary[]
  loading: boolean
  error: PrSurfaceError | null
  hasMore: boolean
  nextPage: number
  loadedAt: number
}

const DEFAULT_CONCURRENCY = 4

/**
 * Aggregates GitHub pull requests across every project in the catalog/sidebar
 * union — the workspace-wide inbox. Hosts differ, so this fans out across
 * connections rather than asking one server for everyone's work.
 *
 * This is additive over `PrsStore`: it calls the same cached, per-project
 * fetchers (`loadFor`, `loadChecks`, `loadEfforts`, `loadGuideMetadata`) that
 * are already keyed by `(serverId, projectPath)`, so single-project pages keep
 * behaving exactly as before — this store only adds a second, independent
 * "read many projects at once" view on top of that cache.
 */
export class PrInboxStore {
  private readonly projectStates = new SvelteMap<string, ProjectPrState>()
  /** Bumped on every `loadAll`; a project's write is dropped if the generation
   *  it started under is no longer current — the guard against a stale
   *  response landing after a newer refresh (or scope change) has begun. */
  private generation = 0

  get projects(): ProjectPrState[] {
    return [...this.projectStates.values()]
  }

  stateFor(serverId: string, projectRoot: string): ProjectPrState | undefined {
    return this.projectStates.get(hostKey(serverId, projectRoot))
  }

  /** True once at least one `loadAll` has settled, even if every project failed. */
  get loaded(): boolean {
    return this.projectStates.size > 0 && this.projects.every((project) => project.loadedAt > 0 || project.error !== null)
  }

  get loading(): boolean {
    return this.projects.some((project) => project.loading)
  }

  /** Every project's last-safe items, flattened. Partial failure never hides a
   *  project that did load — its `items` simply stay from the last success. */
  get allItems(): PullRequestSummary[] {
    return this.projects.flatMap((project) => project.items)
  }

  async loadAll(
    prsStore: PrsStore,
    projects: PrInboxProject[],
    filter: PrFilter,
    opts: { force?: boolean; concurrency?: number } = {},
  ): Promise<void> {
    const generation = ++this.generation
    const activeKeys = new Set(projects.map((project) => hostKey(project.serverId, project.projectRoot)))
    for (const key of this.projectStates.keys()) {
      if (!activeKeys.has(key)) this.projectStates.delete(key)
    }
    for (const project of projects) {
      const key = hostKey(project.serverId, project.projectRoot)
      const existing = this.projectStates.get(key)
      if (existing) {
        existing.label = project.label
        existing.api = project.api
        existing.ctx = project.ctx
        continue
      }
      this.projectStates.set(key, {
        serverId: project.serverId,
        projectRoot: project.projectRoot,
        label: project.label,
        api: project.api,
        ctx: project.ctx,
        items: [],
        loading: false,
        error: null,
        hasMore: false,
        nextPage: 1,
        loadedAt: 0,
      })
    }

    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < projects.length) {
        const project = projects[index++]
        if (generation !== this.generation) return
        await this.loadProject(prsStore, project, filter, generation, opts.force)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker))
  }

  /** `PrsStore.loadAll`/`loadMore` stamp these same two fields off a fetched
   *  page; shared here since a per-project loader needs the identical update
   *  twice — once for a fresh page, once for one appended by `loadMore`. */
  private applyPagination(state: ProjectPrState, page: PrListPage): void {
    state.hasMore = page.hasMore
    state.nextPage = page.page + 1
  }

  private async loadProject(
    prsStore: PrsStore,
    project: PrInboxProject,
    filter: PrFilter,
    generation: number,
    force?: boolean,
  ): Promise<void> {
    const key = hostKey(project.serverId, project.projectRoot)
    const state = this.projectStates.get(key)
    if (!state) return
    state.loading = true
    try {
      const page = await prsStore.loadFor(project.api, project.serverId, project.ctx, filter, { force })
      if (generation !== this.generation) return
      state.items = page.items
      this.applyPagination(state, page)
      state.error = null
      state.loadedAt = Date.now()
      void prsStore.loadChecks(project.api, project.serverId, project.ctx, page.items.map((item) => item.number)).catch(() => {})
      void prsStore.loadGuideMetadata(project.api, project.serverId, project.ctx, page.items).catch(() => {})
    } catch (error) {
      if (generation !== this.generation) return
      // Last-safe snapshot: only the error is set, `items` keeps whatever
      // loaded last time so a failing project never blanks its own history —
      // and other projects are untouched, so a partial failure never hides
      // the projects that did load.
      state.error = prSurfaceError(error)
    } finally {
      if (generation === this.generation) state.loading = false
    }
  }

  async loadMore(prsStore: PrsStore, serverId: string, projectRoot: string): Promise<void> {
    const state = this.stateFor(serverId, projectRoot)
    if (!state || !state.hasMore || state.loading) return
    const generation = this.generation
    const page = state.nextPage
    state.loading = true
    try {
      const result = await prsStore.loadFor(state.api, state.serverId, state.ctx, { state: 'open' }, { page })
      if (generation !== this.generation || state.nextPage !== page) return
      const known = new Set(state.items.map((item) => item.number))
      for (const item of result.items) if (!known.has(item.number)) state.items.push(item)
      this.applyPagination(state, result)
      void prsStore.loadChecks(state.api, state.serverId, state.ctx, result.items.map((item) => item.number)).catch(() => {})
    } catch (error) {
      if (generation === this.generation) state.error = prSurfaceError(error)
    } finally {
      if (generation === this.generation) state.loading = false
    }
  }

  async loadEffortsFor(prsStore: PrsStore, serverId: string, projectRoot: string, numbers: number[]): Promise<void> {
    const state = this.stateFor(serverId, projectRoot)
    if (!state) return
    await prsStore.loadEfforts(state.api, state.serverId, state.ctx, numbers).catch(() => {})
  }

  reset(): void {
    this.generation++
    this.projectStates.clear()
  }
}
