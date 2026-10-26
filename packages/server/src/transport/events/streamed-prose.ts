import type { WireNormalizedEvent } from '@solus/contracts/types'

/**
 * Sends the body of an agent's prose once. The text streams as `text_chunk`
 * deltas, then the provider sends the assembled `assistant_message`. A client
 * that received prose since the person last spoke shows it already and treats
 * the assembled text only as a block boundary, so that text ships blank with
 * `textStreamed`. A client that joined later, a replay, and a sub-agent's text
 * (which its card applies as the final copy) get the whole text.
 */
export class StreamedProse {
  /** Per session: the clients that received main-thread prose since the last user message. */
  private recipients = new Map<string, Set<string>>()

  project(sessionId: string, event: WireNormalizedEvent, clients: readonly string[], isBroadcast: boolean): WireNormalizedEvent {
    if ('parentToolUseId' in event && event.parentToolUseId) return event
    switch (event.type) {
      case 'text_chunk': {
        if (!event.text.trim() || !clients.length) return event
        let received = this.recipients.get(sessionId)
        if (!received) this.recipients.set(sessionId, received = new Set())
        for (const clientId of clients) received.add(clientId)
        return event
      }
      case 'assistant_message': {
        const received = this.recipients.get(sessionId)
        if (!isBroadcast || !event.text || !received || !clients.length || !clients.every((clientId) => received.has(clientId))) return event
        return { ...event, text: '', textStreamed: true }
      }
      case 'user_message':
      case 'task_complete':
      case 'turn_settled':
      case 'session_dead':
        this.recipients.delete(sessionId)
        return event
      default:
        return event
    }
  }
}
