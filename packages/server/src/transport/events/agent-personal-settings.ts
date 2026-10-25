import {
  AGENT_PERSONAL_SETTINGS_REQUEST,
  agentPersonalSettingsReplySchema,
  type AgentPersonalSettingsReply,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import { actorFor, ownerKeyOf, type Actor } from '../../admission/actor'
import type { Principal } from '../../admission/principal'

/** A client answers from its own store at once; a longer wait is a socket that is gone. */
const REQUEST_TIMEOUT_MS = 10_000

export interface PersonalSettingsRoute {
  /** The client that submitted the session's running turn, if one did. */
  sourceClientIdOf(sessionId: string): string | undefined
  actorOf(sessionId: string): Actor | undefined
  clientIds(): readonly string[]
  principalOf(clientId: string): Principal
  request(clientId: string, event: string, payload: { patch?: PersonalSettingsDocument }, answer: typeof agentPersonalSettingsReplySchema, timeoutMs: number): Promise<AgentPersonalSettingsReply>
}

/**
 * The clients that may answer for the person a session works for: the one that
 * started the turn first, then that person's other connections. Never a client
 * of another person, and none for the host's own work.
 */
export function personalSettingsClients(route: PersonalSettingsRoute, sessionId: string): string[] {
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

/** Reads the person's settings, or changes them when `patch` is given, through the first of their clients that answers. */
export async function requestPersonalSettings(route: PersonalSettingsRoute, sessionId: string | undefined, patch?: PersonalSettingsDocument): Promise<AgentPersonalSettingsReply> {
  const clients = sessionId ? personalSettingsClients(route, sessionId) : []
  for (const clientId of clients) {
    try {
      return await route.request(clientId, AGENT_PERSONAL_SETTINGS_REQUEST, patch ? { patch } : {}, agentPersonalSettingsReplySchema, REQUEST_TIMEOUT_MS)
    } catch {
      // The socket went away or did not answer: ask the person's next client.
    }
  }
  return { ok: false, error: "No Solus client of this person is connected to this host. Their settings live on their devices; open Solus and try again." }
}
