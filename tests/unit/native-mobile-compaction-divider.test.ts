import { describe, expect, test } from 'bun:test'
import type { ContextCompaction } from '@solus/contracts/types'
import { compactionDividerText } from '@solus/contracts/context-compaction'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { deriveThreadFeedPresentation } from '../../apps/mobile/src/features/threads/thread-feed-presentation'

/**
 * The phone shows the same compaction divider as desktop: it appears when the
 * compaction starts, the same row states the result, and it never stays as a
 * running divider after the work stops.
 */

function compactions(model: TranscriptModel): ContextCompaction[] {
  return model.order.flatMap((id) => {
    const item = model.items.get(id)
    return item?.kind === 'compaction' ? [item.compaction] : []
  })
}

function liveModel(): TranscriptModel {
  const model = TranscriptModel.fromHistory('session-1', { messages: [], before: null })
  model.setStatus('running')
  return model
}

describe('compaction divider on mobile', () => {
  test('a start draws a running divider that its stop settles in place', () => {
    const model = liveModel()
    model.apply({ type: 'context_compaction', state: 'start', trigger: 'manual' })
    const [runningId] = model.order
    expect(compactionDividerText(compactions(model)[0])).toEqual({ label: 'Compacting context', detail: null })

    model.apply({ type: 'context_compaction', state: 'stop', trigger: 'manual', preTokens: 180_000, postTokens: 12_000 })
    expect(model.order).toEqual([runningId])
    expect(compactionDividerText(compactions(model)[0])).toEqual({ label: 'Context compacted on request', detail: '180K → 12K tokens' })
  })

  test('Claude settles one compaction twice; one divider keeps the record', () => {
    const model = liveModel()
    model.apply({ type: 'context_compaction', state: 'start', trigger: 'auto' })
    model.apply({ type: 'context_compaction', state: 'stop', trigger: 'auto' })
    model.apply({ type: 'context_compaction', state: 'stop', trigger: 'manual', preTokens: 180_000, postTokens: 12_000 })
    expect(compactions(model)).toEqual([{ trigger: 'manual', preTokens: 180_000, postTokens: 12_000 }])
  })

  test('a failed compaction, or a turn that ends first, leaves no divider', () => {
    const failed = liveModel()
    failed.apply({ type: 'context_compaction', state: 'start' })
    failed.apply({ type: 'context_compaction', state: 'stop', failed: true })
    expect(compactions(failed)).toEqual([])

    const stopped = liveModel()
    stopped.apply({ type: 'context_compaction', state: 'start' })
    stopped.setStatus('interrupted')
    expect(compactions(stopped)).toEqual([])
  })

  test('history shows the divider the provider recorded', () => {
    const model = TranscriptModel.fromHistory('session-1', {
      messages: [{ role: 'system', content: '', timestamp: 1, messageId: 'boundary-1', compaction: { trigger: 'auto', preTokens: 975_939 } }],
      before: null,
    })
    expect(model.order).toEqual(['boundary-1'])
    expect(compactionDividerText(compactions(model)[0])).toEqual({ label: 'Context compacted automatically', detail: 'from 976K tokens' })
  })

  test('a finished turn never folds the divider away', () => {
    const rows = deriveThreadFeedPresentation({
      entries: [
        { id: 'u1', kind: 'user' },
        { id: 'a1', kind: 'assistant' },
        { id: 't1', kind: 'tool' },
        { id: 'c1', kind: 'compaction' },
        { id: 't2', kind: 'tool' },
        { id: 'a2', kind: 'assistant' },
      ],
      turnActive: false,
      working: false,
      expandedTurnIds: new Set(),
      expandedWorkGroupIds: new Set(),
    })
    expect(rows).toContainEqual({ type: 'compaction', id: 'c1' })
  })
})
