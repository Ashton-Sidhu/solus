import type { Message } from '@solus/contracts/types'
import { MAX_SESSION_TOOL_INPUTS, type DeferredToolInput, type SessionToolInput } from '@solus/contracts/session-history'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'

function sourceKey(ref: DeferredToolInput): string {
  return JSON.stringify([ref.serverId, ref.sessionId, ref.projectPath, ref.provider])
}

/** The fetched input lives on its existing reactive message. Concurrent summary
 * expansions share requests; failed/missing inputs remain available for retry. */
export class ToolHistoryStore {
  private pending = new Map<string, Promise<SessionToolInput[]>>()

  constructor(private apiFor: (serverId: string) => Pick<HostApi, 'loadSessionToolInputs'> =
    (serverId) => serverConnections.apiFor(serverId)) {}

  async load(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>()
    for (const message of messages) {
      const ref = message.historyToolInput
      if (!ref) continue
      if (message.toolInput !== undefined) { delete message.historyToolInput; continue }
      const key = sourceKey(ref)
      const group = groups.get(key)
      if (group) group.push(message)
      else groups.set(key, [message])
    }
    await Promise.all([...groups].map(async ([source, group]) => {
      for (let offset = 0; offset < group.length; offset += MAX_SESSION_TOOL_INPUTS) {
        const batch = group.slice(offset, offset + MAX_SESSION_TOOL_INPUTS)
          .filter((message) => message.historyToolInput && sourceKey(message.historyToolInput) === source)
        if (!batch.length) continue
        const refs = batch.map((message) => message.historyToolInput!)
        const origin = refs[0]
        const keys = [...new Set(refs.map((ref) => ref.key))].sort()
        for (const ref of refs) { ref.loading = true; delete ref.error }
        const requests = new Map<string, Promise<SessionToolInput[]>>()
        try {
          const newKeys = keys.filter((key) => !this.pending.has(source + key))
          if (newKeys.length) {
            const pending = this.apiFor(origin.serverId).loadSessionToolInputs({
              sessionId: origin.sessionId, projectPath: origin.projectPath,
              provider: origin.provider, keys: newKeys,
            })
            for (const key of newKeys) this.pending.set(source + key, pending)
          }
          for (const key of keys) requests.set(source + key, this.pending.get(source + key)!)
          const results = await Promise.all(new Set(requests.values()))
          const inputs = new Map(results.flat().map((input) => [input.key, input.toolInput]))
          batch.forEach((message, index) => {
            const ref = refs[index]
            if (message.historyToolInput !== ref) return
            const input = inputs.get(ref.key)
            if (input === undefined) {
              ref.error = 'Tool details are no longer available in this history.'
              return
            }
            // A live update can supply a newer input while the read is in flight.
            if (message.toolInput === undefined) message.toolInput = input
            delete message.historyToolInput
          })
        } catch {
          batch.forEach((message, index) => {
            if (message.historyToolInput === refs[index]) refs[index].error = 'Could not load tool details. Try again.'
          })
        } finally {
          for (const ref of refs) ref.loading = false
          for (const [key, pending] of requests) {
            if (this.pending.get(key) === pending) this.pending.delete(key)
          }
        }
      }
    }))
  }
}
