import type {
  CandidateTicket,
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  TaskCandidateOptions,
  TaskList,
  TaskStatus,
  TaskSyncField,
  TicketPatch,
} from '@solus/contracts/task-types'
import type { AssetReference } from '../task-assets'

/** Provider boundary for the local-first task sync engine. Provider-native
 * states, timestamps, payloads, comments, and URLs must be normalized here. */
export interface TaskSyncAdapter {
  readonly id: ExternalTicketRef['provider']
  /**
   * Fields this provider can take a local write for. The engine never pushes —
   * and never keeps holding — a field outside this set, so the task page cannot
   * show a pending change that has nowhere to land.
   */
  readonly writableFields: ReadonlySet<TaskSyncField>
  /** Canonical representatives of the status distinctions this provider can
   * expose to a provider-owned ticket editor. */
  readonly statuses: readonly TaskStatus[]
  /**
   * The finest state this provider can genuinely represent, as a comparison
   * key. Two Solus statuses sharing a key are indistinguishable upstream, which
   * is the one fact the engine needs to decide both directions:
   *
   * - inbound, an upstream status whose key matches the local one is not a
   *   change, so local nuance (`inbox`, `in_review`, `dropped`) survives;
   * - outbound, a pushed status whose key matches the current local one counts
   *   as acknowledged, so a field the provider cannot express does not stay
   *   dirty forever.
   *
   * GitHub collapses six statuses into three. Jira keeps `in_review` when its
   * workflow names one, and only merges `done` with `dropped`.
   */
  statusKey(status: TaskStatus): string
  /** The provider's own deep link for a ticket, used when importing by id
   *  before anything has been fetched. Async because a provider may have to ask
   *  the live connection which host to address. */
  ticketUrl(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    externalId: string,
  ): Promise<string>
  fetchTicket(ref: ExternalTicketRef): Promise<NormalizedTicket>
  fetchTickets(refs: ExternalTicketRef[]): Promise<NormalizedTicket[]>
  /**
   * The ids in this scope that changed upstream since `since`, when the provider
   * can answer that in one bounded query.
   *
   * This is what keeps the background poll from costing one request per linked
   * task: normally nothing changed, and the whole poll is a single call. Return
   * `null` — or omit the method — to say "cannot answer", and the engine falls
   * back to asking about every link individually. Answering `null` is always
   * safe; answering an incomplete set is not, because the scope's poll mark
   * moves forward either way and a ticket left out is never revisited.
   */
  changedSince?(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    since: number,
  ): Promise<Set<string> | null>
  pushFields(ref: ExternalTicketRef, patch: TicketPatch): Promise<NormalizedTicket>
  postComment(ref: ExternalTicketRef, body: string): Promise<NormalizedTaskComment>
  /**
   * Upload the local assets a body references and return the body to send
   * upstream. Durable Markdown is untouched: only the returned body carries
   * provider URLs. Throws when an asset cannot be published, so the caller can
   * keep the content local and offer the provider's own composer.
   */
  publishAssets(ref: ExternalTicketRef, body: string): Promise<string>
  /** References in a body this provider cannot publish at all. */
  unpublishableAssets(body: string): AssetReference[]
  createTicket(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    patch: Required<Pick<TicketPatch, 'title'>> & TicketPatch,
  ): Promise<NormalizedTicket>
  /** Live provider-owned rows for the bound project. These are never stored as
   * Solus tasks; the caller may retain only a disposable offline snapshot. */
  listTickets(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options?: TaskCandidateOptions,
  ): Promise<TaskList>
  listCandidates(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options?: TaskCandidateOptions,
  ): Promise<CandidateTicket[]>
}
