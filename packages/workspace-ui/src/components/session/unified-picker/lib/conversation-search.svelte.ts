import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { loadServers, type SavedServer } from '@solus/client-core/server-registry'
import { stampSessionMetas } from '@solus/client-core/session-meta'
import { sessionMetaFromRecord } from '@solus/contracts/session-record-meta'
import { isSolusApiId } from '@solus/contracts/uplink'
import type { AgentId, SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import { projectsStore } from '../../../../contexts/projects/projects.store.svelte'
import { hostRolesStore } from '../../../../contexts/connections/host-roles.store.svelte'
import { activeSince, type PickerFilters } from './picker-filters'
import type { PickerResultType } from './picker-preferences'
import type { PickerSearchMode } from './picker-search'

/** The homes a search reads. */
export interface ConversationSearchHosts<Api = Pick<HostApi, 'sessionRecordSearch'>> {
  /** In reading order: this machine, the person's other machines, then the
   *  organization's workspace service. */
  searchServerIds(): string[]
  apiFor(serverId: string): Api
  /** The connected saved server a record's runner host id names, or null. */
  connectedRunnerFor(runnerHostId: string): string | null
}

/**
 * The homes a search reads, from the hosts the app is already talking to.
 * An organization's machine is not asked: the workspace service keeps the
 * record and the mirrored transcript of every session one runs, and it answers
 * when the machine is off. Every other machine keeps its own sessions.
 */
export function searchServerIds(
  connectedServerIds: readonly string[],
  localServerId: string | null,
  saved: readonly Pick<SavedServer, 'id' | 'uplink'>[],
): string[] {
  const organizationMachines = new Set(saved.filter((server) => server.uplink?.kind === 'managed').map((server) => server.id))
  const machines = connectedServerIds.filter((id) => !isSolusApiId(id) && !organizationMachines.has(id))
  const ordered = localServerId && machines.includes(localServerId)
    ? [localServerId, ...machines.filter((id) => id !== localServerId)]
    : machines
  return [...ordered, ...connectedServerIds.filter((id) => isSolusApiId(id))]
}

const registryHosts: ConversationSearchHosts<Pick<HostApi, 'sessionRecordSearch' | 'sessionRecordList'>> = {
  searchServerIds: () => searchServerIds(serverConnections.connectedServerIds(), serverConnections.localServerId(), loadServers()),
  apiFor: (serverId) => serverConnections.apiFor(serverId),
  connectedRunnerFor: (runnerHostId) => {
    const runner = loadServers().find((server) => server.uplink?.hostId === runnerHostId)
    return runner && serverConnections.statusFor(runner.id) === 'connected' ? runner.id : null
  },
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

/**
 * Stamp a workspace service's record with the host that opens it: its runner
 * while that machine is connected, otherwise the service, which shows it
 * read-only with its runner offline (session-home.ts). True when the runner
 * takes it.
 */
function openOnRunner(session: SessionMeta, serviceId: string, hosts: Pick<ConversationSearchHosts, 'connectedRunnerFor'>): boolean {
  const runner = session.serverId ? hosts.connectedRunnerFor(session.serverId) : null
  session.serverId = runner ?? serviceId
  return !!runner
}

const DEBOUNCE_MS = 180
/** A one-character query hits nearly every message a host holds: the hosts
 *  pay for the whole index and the passages are noise. Names still match it. */
export const MIN_CONTENT_QUERY_LENGTH = 2
/** Sessions per host per page. The list asks for the next page when its end
 *  comes into view, so every match is reachable (docs/plans/unified-search.md §6). */
export const PAGE_SIZE = 30

/** What a search is narrowed to, beyond its words and project. */
export interface ConversationSearchOptions {
  /** Names and metadata only: the keywords mode. */
  namesOnly: boolean
  /** Only sessions active at or after this instant. */
  activeSince?: number
  provider?: AgentId
}

/** One host's part of an answer: where its next page starts and how many it has. */
interface HostPage {
  serverId: string
  projectRoot: string | undefined
  next: number
  total: number
}

interface HostHits {
  results: SessionSearchResult[]
  total: number
  indexing: boolean
}

/**
 * The picker's search of sessions, as the user types.
 *
 * Each home is asked, because a session's messages live only where it is kept.
 * Replies are stamped with their host where they enter the client, and a reply
 * to a query the user has since left is dropped: the list must never show hits
 * for words no longer in the box. Every home answers with its total and a first
 * page; `loadMore` reads the next page of each home that has more.
 */
export class ConversationSearch {
  results = $state<SessionSearchResult[]>([])
  /** True from the first keystroke until the last host answers, debounce included. */
  loading = $state(false)
  /** True while a next page is read. */
  loadingMore = $state(false)
  /** How many sessions match on every home; `results` holds the pages read so far. */
  total = $state(0)
  /** Matches not read yet. The list ends with a row that reads them. */
  remaining = $state(0)
  /** A host is still reading its sessions into its index for the first time,
   *  so its hits are not all of them yet. */
  indexing = $state(false)
  private timer: ReturnType<typeof setTimeout> | null = null
  private requestId = 0
  private query = ''
  private options: ConversationSearchOptions = { namesOnly: false }
  private pages: HostPage[] = []

  constructor(
    private readonly hosts: ConversationSearchHosts = registryHosts,
    private readonly debounceMs = DEBOUNCE_MS,
    private readonly scopePathOnHost: ScopePathOnHost = checkoutPathOnHost,
  ) {}

  /** Search for `query`, scoped to one project root or to every project. */
  search(query: string, projectRoot: string | null, options: ConversationSearchOptions = { namesOnly: false }): void {
    const trimmed = query.trim()
    const requestId = ++this.requestId
    if (this.timer) clearTimeout(this.timer)
    this.results = []
    this.total = 0
    this.remaining = 0
    this.indexing = false
    this.loadingMore = false
    this.pages = []
    if (trimmed.length < MIN_CONTENT_QUERY_LENGTH) {
      this.timer = null
      this.loading = false
      return
    }
    this.loading = true
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(requestId, trimmed, projectRoot, options)
    }, this.debounceMs)
  }

  reset(): void {
    this.search('', null)
  }

  /** Read the next page of every home that has more. */
  async loadMore(): Promise<void> {
    if (this.loading || this.loadingMore || this.remaining === 0) return
    const requestId = this.requestId
    this.loadingMore = true
    const pending = this.pages.filter((page) => page.next < page.total)
    const perHost = await Promise.all(pending.map((page) => this.readPage(page.serverId, this.query, page.projectRoot, page.next)))
    if (requestId !== this.requestId) return
    pending.forEach((page, index) => {
      const hits = perHost[index]!
      // A home that fails or answers short has nothing more to give this query.
      page.next = hits.results.length ? page.next + hits.results.length : page.total
    })
    // Appended in place: the rows already listed keep their places.
    this.results.push(...perHost.flatMap((hits) => hits.results))
    this.settleCounts()
    this.loadingMore = false
  }

  private async run(requestId: number, query: string, projectRoot: string | null, options: ConversationSearchOptions): Promise<void> {
    this.query = query
    this.options = options
    const homes = this.hosts.searchServerIds().flatMap((serverId): HostPage[] => {
      // A project scope reaches each host as that host's own checkout of the
      // repository: one path sent everywhere missed clones at other paths and
      // combined unrelated folders that happened to share one.
      const scopedPath = projectRoot ? this.scopePathOnHost(serverId, projectRoot) : undefined
      return scopedPath === null ? [] : [{ serverId, projectRoot: scopedPath ?? projectRoot ?? undefined, next: 0, total: 0 }]
    })
    const perHost = await Promise.all(homes.map((home) => this.readPage(home.serverId, query, home.projectRoot, 0)))
    if (requestId !== this.requestId) return
    homes.forEach((home, index) => {
      home.total = perHost[index]!.total
      home.next = perHost[index]!.results.length
    })
    this.pages = homes
    // The list builder orders the merged hits by the reader's chosen sort;
    // here they are only gathered, newest first as a stable starting order.
    this.results = perHost.flatMap((hits) => hits.results).sort((a, b) => b.ts - a.ts)
    this.indexing = perHost.some((hits) => hits.indexing)
    this.settleCounts()
    this.loading = false
  }

  private settleCounts(): void {
    this.total = this.pages.reduce((sum, page) => sum + page.total, 0)
    this.remaining = this.pages.reduce((sum, page) => sum + Math.max(0, page.total - page.next), 0)
  }

  private async readPage(serverId: string, query: string, projectRoot: string | undefined, offset: number): Promise<HostHits> {
    try {
      const found = await this.hosts.apiFor(serverId).sessionRecordSearch({
        query, projectRoot, offset, limit: PAGE_SIZE,
        namesOnly: this.options.namesOnly, activeSince: this.options.activeSince, provider: this.options.provider,
      })
      const results = found.results.map(({ record, ...hit }) => ({ ...hit, session: sessionMetaFromRecord(record) }))
      if (!isSolusApiId(serverId)) {
        stampSessionMetas(results.map((hit) => hit.session), serverId)
      } else {
        // A record from the workspace service opens on its runner while that
        // machine is connected; otherwise it stays the service's, and the
        // picker shows it read-only with its runner offline (session-home.ts).
        // A hit's message id is a position in the service's copy, which the
        // runner's index does not know: routed to the runner, the preview
        // opens on the transcript's ends instead of a wrong passage.
        for (const result of results) {
          if (openOnRunner(result.session, serverId, this.hosts)) result.messageId = -1
        }
      }
      return { results, total: found.total, indexing: found.indexing }
    } catch {
      // A host that cannot answer contributes nothing; the others still do.
      return { results: [], total: 0, indexing: false }
    }
  }
}

/**
 * Every session on every home, for the picker's list while its box is empty.
 * A session no task claims is only reachable here or by a query, and a session
 * is as much a thing to return to as a task (task-conversation.md §8). The list
 * is kept between openings of one scope and read again behind it, so the
 * picker opens on it at once.
 */
export class RecentSessions {
  sessions = $state<SessionMeta[]>([])
  /** True from the request until the last home answers. */
  loading = $state(false)
  /** A home is still reading its sessions into its index for the first time. */
  indexing = $state(false)
  /** Why a home could not answer, so an empty list does not claim there is
   *  nothing to list. Null when every home answered. */
  error = $state<string | null>(null)
  /** How many homes were asked, and how many the scope passed over because
   *  they hold no checkout of the project. Null before the first read. */
  asked = $state<number | null>(null)
  passedOver = $state(0)
  private requestId = 0
  private scope: string | null | undefined = undefined

  constructor(
    private readonly hosts: ConversationSearchHosts<Pick<HostApi, 'sessionRecordList'>> = registryHosts,
    private readonly scopePathOnHost: ScopePathOnHost = checkoutPathOnHost,
  ) {}

  /** Read one project root and its worktrees, or every project. */
  async load(projectRoot: string | null): Promise<void> {
    const requestId = ++this.requestId
    // Another scope's list is not this one's, even for a moment.
    if (projectRoot !== this.scope) this.sessions = []
    this.scope = projectRoot
    this.loading = true
    const serverIds = this.hosts.searchServerIds()
    const perHost = await Promise.all(
      serverIds.map(async (serverId): Promise<{ sessions: SessionMeta[]; indexing: boolean; error?: string; passedOver?: boolean }> => {
        const scopedPath = projectRoot ? this.scopePathOnHost(serverId, projectRoot) : undefined
        if (scopedPath === null) return { sessions: [], indexing: false, passedOver: true }
        const projectPath = scopedPath ?? projectRoot ?? undefined
        try {
          const found = await this.hosts.apiFor(serverId).sessionRecordList({
            projectPath,
            includeWorktrees: projectPath ? true : undefined,
          })
          const sessions = found.records.map(sessionMetaFromRecord)
          if (isSolusApiId(serverId)) for (const session of sessions) openOnRunner(session, serverId, this.hosts)
          else stampSessionMetas(sessions, serverId)
          return { sessions, indexing: found.indexing }
        } catch (error) {
          // A host that cannot answer contributes nothing; the others still do.
          return { sessions: [], indexing: false, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
    if (requestId !== this.requestId) return
    this.sessions = perHost.flatMap((host) => host.sessions)
    this.indexing = perHost.some((host) => host.indexing)
    this.error = perHost.find((host) => host.error)?.error ?? null
    this.asked = serverIds.length
    this.passedOver = perHost.filter((host) => host.passedOver).length
    this.loading = false
  }
}

/** The homes a comment search reads: the connected hosts that keep tasks. */
export interface TaskCommentHosts {
  serverIds(): string[]
  apiFor(serverId: string): Pick<HostApi, 'tasksSearchComments'>
}

const taskHosts: TaskCommentHosts = {
  serverIds: () => serverConnections.connectedServerIds().filter(
    (serverId) => serverConnections.phaseFor(serverId) === 'connected' && hostRolesStore.hasCollaboration(serverId),
  ),
  apiFor: (serverId) => serverConnections.apiFor(serverId),
}

/**
 * The picker's search of what was said about tasks: the tasks whose comments
 * hold every word (docs/plans/unified-search.md §7), keyed by task, with the
 * passage of the comment that matched. Debounced with the session search, and
 * a reply to a query the user has left is dropped.
 */
export class TaskCommentSearch {
  /** Task id → the matching comment's passage, markers kept. */
  passages = $state<ReadonlyMap<string, string>>(new Map())
  private timer: ReturnType<typeof setTimeout> | null = null
  private requestId = 0

  constructor(
    private readonly hosts: TaskCommentHosts = taskHosts,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  search(query: string, projectKey: string | null): void {
    const trimmed = query.trim()
    const requestId = ++this.requestId
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.passages = new Map()
    if (trimmed.length < MIN_CONTENT_QUERY_LENGTH) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(requestId, trimmed, projectKey)
    }, this.debounceMs)
  }

  reset(): void {
    this.search('', null)
  }

  private async run(requestId: number, query: string, projectKey: string | null): Promise<void> {
    const perHost = await Promise.all(this.hosts.serverIds().map((serverId) =>
      this.hosts.apiFor(serverId).tasksSearchComments({ query, projectKey: projectKey ?? undefined }).catch(() => []),
    ))
    if (requestId !== this.requestId) return
    this.passages = new Map(perHost.flat().map((hit) => [hit.taskId, hit.snippet]))
  }
}

/** What the picker's searches are asked for: the box, the scope and the reader's choices. */
export interface PickerSearchInput {
  query: string
  /** A project root, or null for every project. */
  scope: string | null
  resultType: PickerResultType
  mode: PickerSearchMode
  filters: PickerFilters
  now: number
}

/**
 * The picker's searches of the hosts, and which of them a list needs: sessions
 * by name or by what was said, every session while the box is empty, and task
 * comments. Keywords mode asks for names only (unified-search.md §8); a list of
 * tasks asks for no session, and a list of sessions for no comment.
 */
export class PickerSearches {
  readonly sessions = new ConversationSearch()
  readonly everySession = new RecentSessions()
  readonly comments = new TaskCommentSearch()

  /** Ask again for what the box, the scope and the choices now say. */
  update(input: PickerSearchInput): void {
    if (input.resultType === 'tasks') this.sessions.reset()
    else {
      this.sessions.search(input.query, input.scope, {
        namesOnly: input.mode === 'keywords',
        activeSince: activeSince(input.filters, input.now),
        provider: input.filters.agent === 'any' ? undefined : input.filters.agent,
      })
    }
    if (input.resultType === 'sessions' || input.mode === 'keywords') this.comments.reset()
    else this.comments.search(input.query, input.scope)
  }

  /** Read every session of the scope, for the list while the box is empty. */
  loadEverySession(scope: string | null, resultType: PickerResultType): void {
    if (resultType !== 'tasks') void this.everySession.load(scope)
  }

  reset(): void {
    this.sessions.reset()
    this.comments.reset()
  }
}
