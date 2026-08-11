import type {
  CandidateTicket,
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  TaskCandidateOptions,
  TicketPatch,
} from '../../../shared/task-types'

/** Provider boundary for the local-first task sync engine. Provider-native
 * states, timestamps, payloads, and comments must be normalized here. */
export interface TaskSyncAdapter {
  readonly id: ExternalTicketRef['provider']
  fetchTicket(ref: ExternalTicketRef): Promise<NormalizedTicket>
  fetchTickets(refs: ExternalTicketRef[]): Promise<NormalizedTicket[]>
  pushFields(ref: ExternalTicketRef, patch: TicketPatch): Promise<NormalizedTicket>
  postComment(ref: ExternalTicketRef, body: string): Promise<NormalizedTaskComment>
  createTicket(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    patch: Required<Pick<TicketPatch, 'title'>> & TicketPatch,
  ): Promise<NormalizedTicket>
  listCandidates(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options?: TaskCandidateOptions,
  ): Promise<CandidateTicket[]>
}

