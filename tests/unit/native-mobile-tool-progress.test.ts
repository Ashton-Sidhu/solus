import { describe, expect, test } from 'bun:test'
import { toolProgressView } from '@solus/contracts/tool-progress'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

/**
 * A `tool_progress` event on the native client (docs/plans/mcp-first-class.md
 * §5): it replaces only its own call's row, for both providers, and the shared
 * view gives the mobile work log and the desktop row the same answer.
 */

function tool(model: TranscriptModel, toolId: string) {
  const item = [...model.items.values()].find((entry) => entry.kind === 'tool' && entry.toolId === toolId)
  return item?.kind === 'tool' ? item : undefined
}

describe('tool progress on the native transcript', () => {
  test('Claude: progress lands on its running call, and the result clears it', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'tool_call', toolName: 'mcp__solus__fake__long', toolId: 'toolu_1', index: 0 })
    // Claude ends the input before the call runs; the row stays running on this client.
    model.apply({ type: 'tool_call_complete', index: 0, toolId: 'toolu_1', toolInput: '{}' })
    model.takeChanges()
    model.apply({ type: 'tool_progress', toolUseId: 'toolu_1', progress: 3, total: 4, message: 'Uploading' })
    expect(tool(model, 'toolu_1')?.progress).toEqual({ progress: 3, total: 4, message: 'Uploading' })
    // One row changed; no row was added.
    const changes = model.takeChanges()
    expect(changes.items).toHaveLength(1)
    expect(changes.order).toBe(false)

    model.apply({ type: 'tool_result', toolUseId: 'toolu_1', status: 'error', errorHead: 'Fake did not finish long within 30 minutes, so Solus stopped the call.', contentBytes: 60 })
    expect(tool(model, 'toolu_1')?.status).toBe('error')
    expect(tool(model, 'toolu_1')?.progress).toBeUndefined()
    // A late event does not touch a finished call.
    model.apply({ type: 'tool_progress', toolUseId: 'toolu_1', progress: 4, total: 4 })
    expect(tool(model, 'toolu_1')?.progress).toBeUndefined()
  })

  test('Codex: progress lands on the call id and leaves the other call alone', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'tool_call', toolName: 'solus.fake__long', toolId: 'call_a', index: 0 })
    model.apply({ type: 'tool_call', toolName: 'solus.fake__other', toolId: 'call_b', index: 0 })
    const other = tool(model, 'call_b')
    model.apply({ type: 'tool_progress', toolUseId: 'call_a', progress: 12, message: 'Indexed 12 files' })
    expect(tool(model, 'call_a')?.progress).toEqual({ progress: 12, message: 'Indexed 12 files' })
    expect(tool(model, 'call_b')).toBe(other)
  })

  test('a call inside a provider sub-agent gets its progress in that transcript', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'tool_call', toolId: 'agent', toolName: 'Agent', index: 0, isSubagent: true })
    model.apply({ type: 'tool_call', toolId: 'toolu_child', toolName: 'mcp__solus__fake__long', index: 0, parentToolUseId: 'agent' })
    model.apply({ type: 'tool_progress', toolUseId: 'toolu_child', progress: 1, total: 2 })
    const child = tool(model, 'agent')?.children
    expect(child && tool(child, 'toolu_child')?.progress).toEqual({ progress: 1, total: 2 })
  })

  test('a stopped turn drops progress that still arrives', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'tool_call', toolName: 'solus.fake__long', toolId: 'call_a', index: 0 })
    model.apply({ type: 'status_change', status: 'interrupted', oldStatus: 'running' })
    model.apply({ type: 'tool_progress', toolUseId: 'call_a', progress: 1 })
    expect(tool(model, 'call_a')?.progress).toBeUndefined()
  })
})

describe('the progress view both clients read', () => {
  test('no report yet: nothing to show', () => {
    expect(toolProgressView(undefined)).toBeNull()
  })

  test('a total gives a bar and a whole percent, held inside 0 to 100', () => {
    expect(toolProgressView({ progress: 1, total: 3 })).toEqual({ message: null, fraction: 1 / 3, percent: 33 })
    expect(toolProgressView({ progress: 9, total: 3 })?.percent).toBe(100)
    expect(toolProgressView({ progress: -1, total: 3 })?.percent).toBe(0)
  })

  test('no total, or a total of zero, gives no bar: the count has no meaning without it', () => {
    expect(toolProgressView({ progress: 40, message: 'Reading pages' })).toEqual({ message: 'Reading pages', fraction: null, percent: null })
    expect(toolProgressView({ progress: 1, total: 0 })?.fraction).toBeNull()
  })
})
