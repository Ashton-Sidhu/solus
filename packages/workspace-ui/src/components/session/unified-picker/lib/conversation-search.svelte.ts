import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { stampSessionMetas } from '@solus/client-core/session-meta'
import type { SessionSearchResult } from '@solus/contracts/types'

/** The hosts a search fans out to: the ones the app is already talking to. */
export interface ConversationSearchHosts {
  connectedServerIds(): string[]
  apiFor(serverId: string): Pick<HostApi, 'searchSessions'>
}

const DEBOUNCE_MS = 180
/** Per host. The list is scanned, not paged, so more than this is noise. */
const RESULTS_PER_HOST = 20

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
  private timer: ReturnType<typeof setTimeout> | null = null
  private requestId = 0

  constructor(
    private readonly hosts: ConversationSearchHosts = serverConnections,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  /** Search for `query`, scoped to one project root or to every project. */
  search(query: string, projectRoot: string | null): void {
    const trimmed = query.trim()
    const requestId = ++this.requestId
    if (this.timer) clearTimeout(this.timer)
    if (!trimmed) {
      this.timer = null
      this.results = []
      this.loading = false
      return
    }
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
        try {
          const hits = await this.hosts.apiFor(serverId).searchSessions({
            query,
            projectRoot: projectRoot ?? undefined,
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
    // Rank is not comparable across hosts, so the merged list is ordered by
    // the date each row shows, newest hit first.
    this.results = perHost.flat().sort((a, b) => b.ts - a.ts)
    this.loading = false
  }
}
