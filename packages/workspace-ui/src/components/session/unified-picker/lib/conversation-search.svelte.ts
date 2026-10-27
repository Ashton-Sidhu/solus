import { SessionSearch, SESSION_SEARCH_PAGE_SIZE } from '@solus/client-core/session-search'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { loadServers, type SavedServer } from '@solus/client-core/server-registry'
import { stampSessionMetas } from '@solus/client-core/session-meta'
import { connectedRunnerFor } from '@solus/client-core/session-runner'
import { sessionMetaFromRecord } from '@solus/contracts/session-record-meta'
import { isSolusApiId } from '@solus/contracts/uplink'
import { isRepositoryKey } from '@solus/contracts/repository-key'
import type { AgentId, SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import { localProjectParts } from '@solus/client-core/project-identity'
import { projectsStore } from '../../../../contexts/projects/projects.store.svelte'
import { hosts } from '../../../../contexts/hosts/hosts.svelte'
import { activeSince, type PickerFilters } from './picker-filters'
import type { PickerResultType } from './picker-preferences'
import type { PickerSearchMode } from './picker-search'
import { isAbsoluteHostPath } from '@solus/contracts/host-path'

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
  const organizationMachines = organizationMachineIds(saved)
  const machines = connectedServerIds.filter((id) => !isSolusApiId(id) && !organizationMachines.has(id))
  const ordered = localServerId && machines.includes(localServerId)
    ? [localServerId, ...machines.filter((id) => id !== localServerId)]
    : machines
  return [...ordered, ...connectedServerIds.filter((id) => isSolusApiId(id))]
}

const registryHosts: ConversationSearchHosts<Pick<HostApi, 'sessionRecordSearch' | 'sessionRecordList'>> = {
  searchServerIds: () => searchServerIds(serverConnections.connectedServerIds(), serverConnections.localServerId(), loadServers()),
  apiFor: (serverId) => serverConnections.apiFor(serverId),
  connectedRunnerFor: (runnerHostId) => connectedRunnerFor(runnerHostId),
}

/**
 * What one host is asked for a project scope (docs/plans/project-model.md §1).
 * A machine is asked for its own checkout of the project. The workspace service
 * holds no checkout: it is asked for the repository, so it answers with the
 * sessions of every machine that ran it, a removed one included.
 */
export type HostScope = { projectRoot: string } | { repositoryKey: string }

/** A host's scope for a project, or null when the host holds none of it and is not asked. */
export type ScopeOnHost = (serverId: string, projectKey: string) => HostScope | null

/** The organizations' machines: their sessions are read from the workspace service. */
function organizationMachineIds(saved: readonly Pick<SavedServer, 'id' | 'uplink'>[]): Set<string> {
  return new Set(saved.filter((server) => server.uplink?.kind === 'managed').map((server) => server.id))
}

/**
 * One host's scope for a project, from the project's checkouts. The workspace
 * service is asked for the repository; a local-only project has none there.
 */
export function scopeFromCheckouts(
  serverId: string,
  projectKey: string,
  checkouts: readonly { serverId: string; projectRoot: string }[],
): HostScope | null {
  if (isSolusApiId(serverId)) return isRepositoryKey(projectKey) ? { repositoryKey: projectKey } : null
  const checkout = checkouts.find((entry) => entry.serverId === serverId)
  return checkout ? { projectRoot: checkout.projectRoot } : null
}

function checkoutScopeOnHost(serverId: string, projectKey: string): HostScope | null {
  // A scope that is a path no host has named is sent as it is.
  if (isAbsoluteHostPath(projectKey) || projectKey.startsWith('~')) return { projectRoot: projectKey }
  const local = localProjectParts(projectKey)
  const catalogued = projectsStore.checkoutsOf(projectKey)
  const checkouts = catalogued.length || !local ? catalogued : [{ serverId: local.serverId, projectRoot: local.path }]
  return scopeFromCheckouts(serverId, projectKey, checkouts)
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
export const PAGE_SIZE = SESSION_SEARCH_PAGE_SIZE

/** What a search is narrowed to, beyond its words and project. */
export interface ConversationSearchOptions {
  /** Names and metadata only: the keywords mode. */
  namesOnly: boolean
  /** Only sessions active at or after this instant. */
  activeSince?: number
  provider?: AgentId
  /** Only sessions on this machine. The workspace service is still asked:
   *  its records open on the machine that ran them. */
  serverId?: string
}

/** Reactive desktop/web view of the shared cross-host search. */
export class ConversationSearch {
  results = $state<SessionSearchResult[]>([])
  loading = $state(false)
  loadingMore = $state(false)
  total = $state(0)
  remaining = $state(0)
  indexing = $state(false)
  error = $state<string | null>(null)
  private readonly pages: SessionSearch
  private readonly mapped = new WeakMap<import('@solus/contracts/types').SessionRecordSearchResult, SessionSearchResult>()

  constructor(
    private readonly hosts: ConversationSearchHosts = registryHosts,
    debounceMs = DEBOUNCE_MS,
    private readonly scopeOnHost: ScopeOnHost = checkoutScopeOnHost,
  ) {
    this.pages = new SessionSearch(serverId => hosts.apiFor(serverId), () => this.apply(), debounceMs)
  }

  search(query: string, projectRoot: string | null, options: ConversationSearchOptions = { namesOnly: false }): void {
    const homes = this.hosts.searchServerIds().flatMap(serverId => {
      if (options.serverId && serverId !== options.serverId && !isSolusApiId(serverId)) return []
      const scope = projectRoot ? this.scopeOnHost(serverId, projectRoot) : undefined
      return scope === null ? [] : [{ serverId, scope }]
    })
    this.pages.search(query, homes, { namesOnly: options.namesOnly, activeSince: options.activeSince, provider: options.provider })
  }

  reset(): void { this.pages.reset() }
  async loadMore(): Promise<void> { await this.pages.loadMore() }

  private apply(): void {
    const state = this.pages.state
    this.loading = state.loading
    this.loadingMore = state.loadingMore
    this.total = state.total
    this.remaining = state.remaining
    this.indexing = state.indexing
    this.error = state.errors.length ? state.errors.map(error => `${error.serverId}: ${error.message}`).join('; ') : null
    const next = state.hits.map(({ serverId, result }) => {
      const held = this.mapped.get(result)
      if (held) return held
      const { record, ...hit } = result
      const session = sessionMetaFromRecord(record)
      if (isSolusApiId(serverId)) {
        if (openOnRunner(session, serverId, this.hosts)) {
          hit.messageId = -1
          hit.additionalMatches = hit.additionalMatches.map(passage => ({ ...passage, messageId: -1 }))
        }
      }
      else stampSessionMetas([session], serverId)
      const mapped = { ...hit, session }
      this.mapped.set(result, mapped)
      return mapped
    })
    if (this.results.length <= next.length && this.results.every((result, index) => result === next[index])) this.results.push(...next.slice(this.results.length))
    else this.results = next
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
    private readonly scopeOnHost: ScopeOnHost = checkoutScopeOnHost,
  ) {}

  /** Read one project's checkouts and their worktrees, or every project. */
  async load(projectRoot: string | null): Promise<void> {
    const requestId = ++this.requestId
    // Another scope's list is not this one's, even for a moment.
    if (projectRoot !== this.scope) this.sessions = []
    this.scope = projectRoot
    this.loading = true
    const serverIds = this.hosts.searchServerIds()
    const perHost = await Promise.all(
      serverIds.map(async (serverId): Promise<{ sessions: SessionMeta[]; indexing: boolean; error?: string; passedOver?: boolean }> => {
        const scope = projectRoot ? this.scopeOnHost(serverId, projectRoot) : undefined
        if (scope === null) return { sessions: [], indexing: false, passedOver: true }
        try {
          const found = await this.hosts.apiFor(serverId).sessionRecordList(
            !scope ? { scope: 'all' } : 'repositoryKey' in scope ? { repositoryKey: scope.repositoryKey, scope: 'all' } : { projectPath: scope.projectRoot, includeWorktrees: true, scope: 'all' },
          )
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
    (serverId) => serverConnections.readinessFor(serverId).readiness === 'ready' && hosts.hasCollaboration(serverId),
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
    private readonly scopeOnHost: ScopeOnHost = checkoutScopeOnHost,
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
    // A project scope reaches each host the way the session search asks it: a
    // machine by its checkout, the workspace service by the repository its tasks name.
    const perHost = await Promise.all(this.hosts.serverIds().map((serverId) => {
      const scope = projectKey ? this.scopeOnHost(serverId, projectKey) : undefined
      if (scope === null) return []
      const scopedKey = !scope ? undefined : 'repositoryKey' in scope ? scope.repositoryKey : scope.projectRoot
      return this.hosts.apiFor(serverId).tasksSearchComments({ query, projectKey: scopedKey }).catch(() => [])
    }))
    if (requestId !== this.requestId) return
    this.passages = new Map(perHost.flat().map((hit) => [hit.taskId, hit.snippet]))
  }
}

/** What the picker's searches are asked for: the box, the scope and the reader's choices. */
export interface PickerSearchInput {
  query: string
  /** A project key, or null for every project. */
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
        serverId: input.filters.host === 'any' ? undefined : input.filters.host,
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
