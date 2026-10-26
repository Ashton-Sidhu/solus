import {
  AGENT_PERSONAL_REQUEST,
  agentPersonalReplySchema,
  type AgentPersonalReply,
  type AgentPersonalRequest,
} from '@solus/contracts/agent-personal-request'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import type { PersonalAnswer } from '../../execution/agents/tools/config-tools'
import type { PersonConnections } from './person-connections'

/** A client answers from its own store at once; a longer wait is a socket that is gone. */
const REQUEST_TIMEOUT_MS = 10_000

/** What the runtime knows about a session's turn. */
export interface TurnSessions {
  /** The client that submitted the session's running turn, if one did. */
  sourceClientIdOf(sessionId: string): string | undefined
  actorOf(sessionId: string): Actor | undefined
}

/** Sends one request down a client's socket and resolves with its answer; rejects when the client has no socket or does not answer. */
export type ClientRequest = (clientId: string, event: string, payload: AgentPersonalRequest, answer: typeof agentPersonalReplySchema, timeoutMs: number) => Promise<AgentPersonalReply>

/**
 * An agent's requests for the settings, agent profile, and device of the person
 * its session works for, through that person's connected clients.
 */
export class PersonalRequests {
  constructor(
    private readonly connections: PersonConnections,
    private readonly sessions: TurnSessions,
    private readonly request: ClientRequest,
  ) {}

  /**
   * The clients that may answer for the person a session works for: the one that
   * started the turn first, then that person's other connections. None for the
   * host's own work.
   */
  clientsFor(sessionId: string): string[] {
    const actor = this.sessions.actorOf(sessionId)
    const personKey = actor ? ownerKeyOf(actor) : null
    if (!personKey) return []
    const source = this.sessions.sourceClientIdOf(sessionId)
    const others = this.connections.of(personKey).filter((clientId) => clientId !== source)
    return source && this.connections.includes(source, personKey) ? [source, ...others] : others
  }

  /**
   * Reads the person's settings, agent profile, and device, and changes what the
   * request names, through the first of their clients that answers. A device change
   * goes only to the client that started the turn: another of the person's clients
   * is another machine.
   */
  async send(sessionId: string | undefined, request: AgentPersonalRequest): Promise<PersonalAnswer> {
    const clients = sessionId ? this.clientsFor(sessionId) : []
    const turnClientId = sessionId ? this.sessions.sourceClientIdOf(sessionId) : undefined
    const candidates = request.device ? clients.filter((clientId) => clientId === turnClientId) : clients
    for (const clientId of candidates) {
      try {
        const reply = await this.request(clientId, AGENT_PERSONAL_REQUEST, request, agentPersonalReplySchema, REQUEST_TIMEOUT_MS)
        return { reply, fromTurnClient: clientId === turnClientId }
      } catch {
        // The socket went away or did not answer: ask the person's next client.
      }
    }
    const error = request.device
      ? 'The Solus client that started this turn is not connected, so its device settings cannot change. A turn that no client started has no device.'
      : "No Solus client of this person is connected to this host. Their settings and agent profile live on their devices; open Solus and try again."
    return { reply: { ok: false, error }, fromTurnClient: false }
  }
}
