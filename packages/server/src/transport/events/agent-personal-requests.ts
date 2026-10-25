import {
  AGENT_PERSONAL_REQUEST,
  agentPersonalReplySchema,
  type AgentPersonalReply,
  type AgentPersonalRequest,
} from '@solus/contracts/agent-personal-request'
import { actorFor, ownerKeyOf, type Actor } from '../../admission/actor'
import type { Principal } from '../../admission/principal'

/** A client answers from its own store at once; a longer wait is a socket that is gone. */
const REQUEST_TIMEOUT_MS = 10_000

export interface PersonalRoute {
  /** The client that submitted the session's running turn, if one did. */
  sourceClientIdOf(sessionId: string): string | undefined
  actorOf(sessionId: string): Actor | undefined
  clientIds(): readonly string[]
  principalOf(clientId: string): Principal
  request(clientId: string, event: string, payload: AgentPersonalRequest, answer: typeof agentPersonalReplySchema, timeoutMs: number): Promise<AgentPersonalReply>
}

/**
 * The clients that may answer for the person a session works for: the one that
 * started the turn first, then that person's other connections. Never a client
 * of another person, and none for the host's own work.
 */
export function personalClients(route: PersonalRoute, sessionId: string): string[] {
  const actor = route.actorOf(sessionId)
  const personKey = actor ? ownerKeyOf(actor) : null
  if (!personKey) return []
  const isPerson = (clientId: string) => {
    const principal = route.principalOf(clientId)
    return principal.kind !== 'runner' && principal.kind !== 'system' && ownerKeyOf(actorFor(principal)) === personKey
  }
  const source = route.sourceClientIdOf(sessionId)
  const others = route.clientIds().filter((clientId) => clientId !== source && isPerson(clientId))
  return source && isPerson(source) ? [source, ...others] : others
}

/** A client's answer, and whether that client started the turn: only its device settings are the turn's device. */
export interface PersonalAnswer {
  reply: AgentPersonalReply
  fromTurnClient: boolean
}

/**
 * Reads the person's settings, agent profile, and device, and changes what the
 * request names, through the first of their clients that answers. A device change
 * goes only to the client that started the turn: another of the person's clients
 * is another machine.
 */
export async function requestPersonal(route: PersonalRoute, sessionId: string | undefined, request: AgentPersonalRequest): Promise<PersonalAnswer> {
  const clients = sessionId ? personalClients(route, sessionId) : []
  const turnClientId = sessionId ? route.sourceClientIdOf(sessionId) : undefined
  const candidates = request.device ? clients.filter((clientId) => clientId === turnClientId) : clients
  for (const clientId of candidates) {
    try {
      const reply = await route.request(clientId, AGENT_PERSONAL_REQUEST, request, agentPersonalReplySchema, REQUEST_TIMEOUT_MS)
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
