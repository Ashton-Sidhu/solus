import { mcpAppLiveToolName } from '@solus/contracts/mcp-apps'
import type { StreamEvent } from '@solus/contracts/claude-types'
import type { NormalizedEvent } from '@solus/contracts/types'

/** At most this often for one call: a live app card takes ten a second. */
export const PARTIAL_INPUT_INTERVAL_MS = 100
/** Each update carries all of the input, so a longer input waits for its end. */
export const MAX_PARTIAL_INPUT_CHARS = 64 * 1024

/**
 * The input so far of a main-thread Solus integration tool, for its live app
 * card (docs/plans/mcp-first-class.md §14.1). Every other tool keeps its input
 * until the input is whole, because nothing reads it while it streams.
 */
export class ClaudePartialToolInputs {
  private readonly calls = new Map<number, { toolId: string; sentAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** One main-thread stream event, after the normalizer took its input: the update to send, or null. */
  follow(sub: NonNullable<StreamEvent['event']>, inputs: ReadonlyMap<number, string>): Extract<NormalizedEvent, { type: 'tool_call_update' }> | null {
    if (sub.type === 'message_start') this.calls.clear()
    else if (sub.type === 'content_block_stop') this.calls.delete(sub.index)
    else if (sub.type === 'content_block_start' && sub.content_block.type === 'tool_use') {
      const { id, name } = sub.content_block
      if (id && mcpAppLiveToolName(name)) this.calls.set(sub.index, { toolId: id, sentAt: Number.NEGATIVE_INFINITY })
    } else if (sub.type === 'content_block_delta' && sub.delta.type === 'input_json_delta') {
      return this.update(sub.index, inputs.get(sub.index) ?? '')
    }
    return null
  }

  private update(index: number, input: string): Extract<NormalizedEvent, { type: 'tool_call_update' }> | null {
    const call = this.calls.get(index)
    if (!call || input.length > MAX_PARTIAL_INPUT_CHARS) return null
    const now = this.now()
    if (now - call.sentAt < PARTIAL_INPUT_INTERVAL_MS) return null
    call.sentAt = now
    return { type: 'tool_call_update', toolId: call.toolId, index, toolInput: input, inputPartial: true }
  }
}
