import { describe, expect, test } from 'bun:test'
import { mcpTaskWake, mcpTaskWakeHeader, type McpTask } from '@solus/contracts/integrations/mcp-task'
import { mcpTaskItem, shownMcpTasks } from '@solus/client-core/mcp-task-row'
import { hostNoticeKind } from '../../packages/workspace-ui/src/components/conversation/lib/host-notice'

/**
 * An MCP task as the background work row that desktop, web, and mobile share
 * (docs/plans/mcp-first-class.md §12.5), and the notice its end starts the
 * agent with, known by its text after a reload.
 */

const base: McpTask = { id: 't1', sessionId: 's1', integrationName: 'Reports', tool: 'create_report', status: 'working', createdAt: 1_000, updatedAt: 1_000 }

describe('MCP task row', () => {
  test('a live MCP task can be cancelled, and one that asks can be answered', () => {
    expect(mcpTaskItem(base)).toMatchObject({ label: 'Reports · create_report', detail: 'Running in the background', state: 'running', startedAt: 1_000 })
    expect(mcpTaskItem(base).actions.map((action) => action.id)).toEqual(['cancel'])
    // WHY: Cancel shows as the stop button of the background work rows, so it
    // needs a name that says what it stops; Answer stays a word.
    expect(mcpTaskItem(base).actions.map((action) => !!action.stops)).toEqual([true])
    expect(mcpTaskItem(base).stopLabel).toBe('Stop create_report')
    const asking = mcpTaskItem({ ...base, status: 'input_required', input: [{ key: 'colour', request: { questionId: 'q', questions: [] } }] })
    expect(asking).toMatchObject({ detail: 'Needs your input', state: 'attention' })
    expect(asking.actions.map((action) => action.id)).toEqual(['answer', 'cancel'])
    expect(asking.actions.map((action) => !!action.stops)).toEqual([false, true])
  })

  test('a cancel in flight offers nothing more; an ended MCP task offers nothing and stops its clock', () => {
    expect(mcpTaskItem({ ...base, cancelling: true })).toMatchObject({ detail: 'Cancelling…', actions: [] })
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(mcpTaskItem({ ...base, status })).toMatchObject({ actions: [], startedAt: null })
    }
    expect(mcpTaskItem({ ...base, status: 'cancelled' })).toMatchObject({ state: 'stopped', detail: 'Cancelled' })
    expect(mcpTaskItem({ ...base, status: 'failed', statusMessage: 'The host restarted and the server stopped.' })).toMatchObject({ state: 'failed', detail: 'The host restarted and the server stopped.' })
  })

  test('a status request that fails names the reason on the row, and the MCP task stays live', () => {
    expect(mcpTaskItem({ ...base, problem: 'unreachable' })).toMatchObject({ state: 'attention', detail: 'Could not reach Reports' })
    expect(mcpTaskItem({ ...base, problem: 'needs-sign-in' })).toMatchObject({ state: 'attention', detail: 'Sign in to Reports again' })
    expect(mcpTaskItem({ ...base, problem: 'unreachable' }).actions.map((action) => action.id)).toEqual(['cancel'])
  })

  test('the conversation shows live MCP tasks, and ended ones only during the turn they ended in', () => {
    const ended = { ...base, id: 't2', status: 'completed' as const, updatedAt: 500 }
    expect(shownMcpTasks([base, ended], 400).map((task) => task.id)).toEqual(['t1', 't2'])
    expect(shownMcpTasks([base, ended], 600).map((task) => task.id)).toEqual(['t1'])
  })
})

describe('MCP task notice', () => {
  test('the host message reads back after a reload, with no origin', () => {
    const text = `${mcpTaskWakeHeader('failed', 'Reports · create_report')}\n\nReason: The MCP task expired.`
    expect(mcpTaskWake(text)).toEqual({ outcome: 'failed', label: 'Reports · create_report', body: 'Reason: The MCP task expired.' })
    expect(hostNoticeKind({ content: text })).toBe('mcp-task')
    expect(hostNoticeKind({ content: 'An MCP task ended, said the person.' })).toBeNull()
  })
})
