import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { stampSessionMetas } from '@solus/client-core/session-meta'
import type { SessionSearchResult } from '@solus/contracts/types'
import { projectsStore } from '../../../../contexts/projects/projects.store.svelte'

/** The hosts a search fans out to: the ones the app is already talking to. */
export interface ConversationSearchHosts {
  connectedServerIds(): string[]
  apiFor(serverId: string): Pick<HostApi, 'searchSessions'>
}

/**
 * The folder one host searches for a project scope named by a path: that
 * host's checkout of the same repository (docs/plans/project-model.md §1).
 * `undefined` when the path's repository is not known — the path is sent as
 * it is; `null` when the repository is known and the host holds no checkout of
 * it, so the host is not asked.
 */
export type ScopePathOnHost = (serverId: string, projectRoot: string) => string | null | undefined

function checkoutPathOnHost(serverId: string, projectRoot: string): string | null | undefined {
  const repositoryKey = projectsStore.entries.find((entry) => entry.projectRoot === projectRoot && entry.repositoryKey)?.repositoryKey
  if (!repositoryKey) return undefined
  return projectsStore.checkoutsOf(repositoryKey).find((entry) => entry.serverId === serverId)?.projectRoot ?? null
}

const DEBOUNCE_MS = 180
/** Per host. The list is scanned, not paged, so more than this is noise. */
export const RESULTS_PER_HOST = 20

/**
 * The picker's search of what was said in sessions, as the user types.
 *
 * Every connected host is asked, because a session's messages live only on
 * the host that ran it. Replies are stamped with their host where they enter
 * the client, and a reply to a query the user has since left is dropped: the
 * list must never show hits for words no longer in the box.
 */
export class ConversationSearch {
  results = $state<SessionSearchResult[]>([])
  /** True from the first keystroke until the last host answers, debounce included. */
  loading = $state(false)
  /** A host filled its cap, so `results` is the top of its hits, not all of
   *  them. The list says so where it counts them. */
  capped = $state(false)
  private timer: ReturnType<typeof setTimeout> | null = null
  private requestId = 0

  constructor(
    private readonly hosts: ConversationSearchHosts = serverConnections,
    private readonly debounceMs = DEBOUNCE_MS,
    private readonly scopePathOnHost: ScopePathOnHost = checkoutPathOnHost,
  ) {}

  /** Search for `query`, scoped to one project root or to every project. */
  search(query: string, projectRoot: string | null): void {
    const trimmed = query.trim()
    const requestId = ++this.requestId
    if (this.timer) clearTimeout(this.timer)
    if (!trimmed) {
      this.timer = null
      this.results = []
      this.capped = false
      this.loading = false
      return
    }
    this.results = []
    this.capped = false
    this.loading = true
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(requestId, trimmed, projectRoot)
    }, this.debounceMs)
  }

  reset(): void {
    this.search('', null)
  }

  private async run(requestId: number, query: string, projectRoot: string | null): Promise<void> {
    const serverIds = this.hosts.connectedServerIds()
    const perHost = await Promise.all(
      serverIds.map(async (serverId) => {
        // A project scope reaches each host as that host's own checkout of the
        // repository: one path sent everywhere missed clones at other paths and
        // combined unrelated folders that happened to share one.
        const scopedPath = projectRoot ? this.scopePathOnHost(serverId, projectRoot) : undefined
        if (scopedPath === null) return []
        try {
          const hits = await this.hosts.apiFor(serverId).searchSessions({
            query,
            projectRoot: scopedPath ?? projectRoot ?? undefined,
            prefixLastToken: true,
            limit: RESULTS_PER_HOST,
          })
          stampSessionMetas(hits.map((hit) => hit.session), serverId)
          return hits
        } catch {
          // A host that cannot answer contributes nothing; the others still do.
          return []
        }
      }),
    )
    if (requestId !== this.requestId) return
    // The list builder orders the merged hits by the reader's chosen sort;
    // here they are only gathered, newest first as a stable starting order.
    this.results = perHost.flat().sort((a, b) => b.ts - a.ts)
    this.capped = perHost.some((hits) => hits.length >= RESULTS_PER_HOST)
    this.loading = false
  }
}
