import { z } from 'zod'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

const requestIdSchema = z.union([z.string(), z.number()])
/** The parts of a JSON-RPC message this fetch reads: a request's id, and the id a cancel names. */
const messageSchema = z.object({
  id: requestIdSchema.optional(),
  method: z.string(),
  params: z.object({ requestId: requestIdSchema.optional() }).optional(),
})
type RpcMessage = z.infer<typeof messageSchema>

function messageOf(body: RequestInit['body']): RpcMessage | null {
  const text = z.string().safeParse(body)
  if (!text.success) return null
  try {
    const message = messageSchema.safeParse(JSON.parse(text.data))
    return message.success ? message.data : null
  } catch {
    return null
  }
}

/**
 * The fetch for an MCP HTTP transport, which ends a request's POST when the
 * client cancels the request. The MCP SDK (1.29) sends every POST on the
 * transport's one abort signal, so a stopped tool call kept its connection open
 * until the server answered. A cancelled request is one the SDK sends
 * `notifications/cancelled` for; its POST is aborted while it waits for the
 * response headers. A response that has started streams on as before.
 */
export function cancellableFetch(baseFetch: FetchLike = fetch): FetchLike {
  const waiting = new Map<string | number, AbortController>()
  return async (url, init) => {
    const message = messageOf(init?.body)
    const cancelledId = message?.method === 'notifications/cancelled' ? message.params?.requestId : undefined
    if (cancelledId !== undefined) waiting.get(cancelledId)?.abort(new Error('The MCP request was cancelled.'))
    const requestId = message?.id
    if (init?.method !== 'POST' || requestId === undefined) return baseFetch(url, init)
    const cancel = new AbortController()
    waiting.set(requestId, cancel)
    const signal = init.signal ? AbortSignal.any([init.signal, cancel.signal]) : cancel.signal
    try {
      return await baseFetch(url, { ...init, signal })
    } finally {
      if (waiting.get(requestId) === cancel) waiting.delete(requestId)
    }
  }
}
