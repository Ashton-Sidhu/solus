import { SvelteMap } from 'svelte/reactivity'
import type { SentSessionMessage } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'

/**
 * The host's word on the messages a conversation sent, for cards rebuilt from a
 * transcript. A rebuilt message has no live update behind it, so the card asks
 * the host once whether it is still being carried; after that the live
 * `agent_conversation_update` feed takes over.
 *
 * `undefined` means not asked yet, `null` means the host no longer carries the
 * message: it finished, or it was lost to a host restart.
 */
class SentMessagesStore {
  private bySender = new SvelteMap<string, ReadonlyMap<string, SentSessionMessage>>()
  private consumers = new Map<string, number>()

  /** Retain a sender while at least one mounted card shows a rebuilt message it sent. */
  retain(senderSessionId: string, api: Pick<HostApi, 'sessionMessagesSentBy'>, serverId: string | undefined): () => void {
    const key = `${serverId ?? ''}\u0000${senderSessionId}`
    const count = this.consumers.get(key) ?? 0
    this.consumers.set(key, count + 1)
    if (count === 0) void this.load(key, senderSessionId, api)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.consumers.get(key) ?? 1) - 1
      if (remaining > 0) {
        this.consumers.set(key, remaining)
        return
      }
      this.consumers.delete(key)
      this.bySender.delete(key)
    }
  }

  private async load(key: string, senderSessionId: string, api: Pick<HostApi, 'sessionMessagesSentBy'>): Promise<void> {
    const sent = await api.sessionMessagesSentBy(senderSessionId).catch(() => null)
    // A failed read leaves the messages unknown rather than calling them lost.
    if (!sent || !this.consumers.has(key)) return
    this.bySender.set(key, new Map(sent.map((message) => [message.messageId, message])))
  }

  lookup(senderSessionId: string, serverId: string | undefined, messageId: string): SentSessionMessage | null | undefined {
    const carried = this.bySender.get(`${serverId ?? ''}\u0000${senderSessionId}`)
    if (!carried) return undefined
    return carried.get(messageId) ?? null
  }
}

export const sentMessages = new SentMessagesStore()
export { SentMessagesStore }
