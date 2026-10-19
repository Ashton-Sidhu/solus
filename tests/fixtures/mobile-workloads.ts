/**
 * Synthetic native-mobile workloads for measurement: a long conversation, a
 * streamed reply, and the feed rows `ThreadFeed` derives from them.
 *
 * This is the data path only: the transcript model, its change sets, and the
 * pure feed derivation. No React, renderer, Metro, Hermes, or device runs
 * here, so nothing measured with it is a render count or a phone timing
 * (docs/plans/mobile-compiler-coverage.md, "Runtime gates").
 *
 * Used by `tests/unit/native-mobile-workloads.test.ts` (invariants) and
 * `scripts/measure-mobile-workloads.ts` (timings).
 */
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { deriveThreadFeedPresentation, type FeedSourceEntry, type ThreadFeedRow } from '../../apps/mobile/src/features/threads/thread-feed-presentation'

/** `turns` finished turns: a prompt, a tool call with its result, and a reply of `replyWords` words. */
export function longHistory(turns: number, replyWords = 120): SessionHistoryPage {
  const messages: WireSessionLoadMessage[] = []
  for (let turn = 0; turn < turns; turn++) {
    const at = turn * 10
    messages.push({ role: 'user', content: `Question ${turn}: why does this module allocate on every keystroke?`, messageId: `u${turn}`, timestamp: at })
    messages.push({ role: 'tool', toolId: `t${turn}`, toolName: 'Read', toolInput: `{"file_path":"/repo/src/file-${turn}.ts"}`, content: '', timestamp: at + 1 })
    messages.push({ role: 'tool_result', toolResultForId: `t${turn}`, content: 'line\n'.repeat(20), status: 'ok', timestamp: at + 2 })
    messages.push({ role: 'assistant', content: 'word '.repeat(replyWords), messageId: `a${turn}`, timestamp: at + 3 })
  }
  return { messages, before: null }
}

export function conversation(turns: number): TranscriptModel {
  const model = TranscriptModel.fromHistory('workload', longHistory(turns))
  model.takeChanges()
  return model
}

/** The entries `ThreadFeed` builds from the store's order (ThreadFeed.tsx, `entries`). */
export function feedEntries(model: TranscriptModel): FeedSourceEntry[] {
  return model.order.flatMap((id) => {
    const item = model.items.get(id)
    if (!item) return []
    const kind = item.kind === 'tool' && item.subagent ? 'agent' : item.kind
    if (item.kind === 'notice') return [{ id, kind, tone: item.tone }]
    if (item.kind === 'artifact') return [{ id, kind, workId: item.workId }]
    return [{ id, kind }]
  })
}

/** The rows `ThreadFeed` hands its list, for a conversation that is not working. */
export function feedRows(model: TranscriptModel, turnActive = false): ThreadFeedRow[] {
  return deriveThreadFeedPresentation({
    entries: feedEntries(model),
    turnActive,
    working: turnActive,
    expandedTurnIds: new Set(),
    expandedWorkGroupIds: new Set(),
  })
}

export type StreamStep = {
  /** The model's order changed, so `ThreadFeed` derives every row again. */
  orderChanged: boolean
  /** Items whose own subscribers are told, so only their rows read again. */
  changedItems: string[]
}

function take(model: TranscriptModel): StreamStep {
  const changes = model.takeChanges()
  return { orderChanged: changes.order, changedItems: changes.items }
}

/** One streamed chunk of the reply in progress, and what it changed. */
export function streamChunk(model: TranscriptModel, chunk = 'word '): StreamStep {
  model.apply({ type: 'text_chunk', text: chunk, streaming: true })
  return take(model)
}

/** A new prompt, then a reply streamed one chunk at a time; one step per event. */
export function streamReply(model: TranscriptModel, chunks: number, chunk = 'word '): StreamStep[] {
  model.apply({ type: 'user_message', text: 'Stream the next answer.', clientPromptId: `prompt-${model.order.length}` })
  const steps = [take(model)]
  for (let index = 0; index < chunks; index++) steps.push(streamChunk(model, chunk))
  return steps
}
