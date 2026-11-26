import { describe, expect, test } from 'bun:test'
import {
  claudeToolResultText,
  parseClaudeTaskNotification,
  routeClaudeTaskReplies,
} from '@solus/server/execution/agents/claude/claude-subagent-protocol'
import { parseJsonlLine } from '@solus/server/execution/agents/claude/claude-session-helpers'

describe('Claude subagent protocol', () => {
  test('normalizes string and block tool results through one path', () => {
    expect(claudeToolResultText('done')).toBe('done')
    expect(claudeToolResultText([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]))
      .toBe('first\nsecond')
  })

  test('extracts a completed background task result', () => {
    expect(parseClaudeTaskNotification(`
      <task-notification>
        <tool-use-id>agent-1</tool-use-id>
        <result>Found the issue.</result>
      </task-notification>
    `)).toEqual({ toolUseId: 'agent-1', result: 'Found the issue.' })
  })

  test('replays task results into their parent card and drops launch acknowledgements', () => {
    const timestamp = '2026-01-01T00:00:00.000Z'
    const notification = JSON.stringify({
      type: 'user',
      timestamp,
      message: {
        content: '<task-notification><tool-use-id>agent-1</tool-use-id><result>Done.</result></task-notification>',
      },
    })
    const launch = JSON.stringify({
      type: 'user',
      timestamp,
      toolUseResult: { isAsync: true, status: 'async_launched' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'Launched' }],
      },
    })

    expect(parseJsonlLine(notification)).toEqual({
      role: 'assistant',
      content: 'Done.',
      parentToolUseId: 'agent-1',
      timestamp: Date.parse(timestamp),
    })
    expect(parseJsonlLine(launch)).toBeNull()
  })
})

test('routes resumed task output to the original agent and keeps the follow-up call in the parent', () => {
  const notification = (task: string, tool: string) => parseJsonlLine(JSON.stringify({
    type: 'user', message: { content: '<task-notification><task-id>' + task + '</task-id><tool-use-id>' + tool + '</tool-use-id><result>Finished</result></task-notification>' },
  }))!
  const rows = routeClaudeTaskReplies([
    { role: 'tool', toolName: 'Agent', toolId: 'launch', content: '', timestamp: 1 },
    notification('agent-a', 'launch'),
    { role: 'tool', toolName: 'SendMessage', toolId: 'resume', content: '', timestamp: 2 },
    notification('agent-b', 'other'),
    { role: 'assistant', parentToolUseId: 'resume', content: 'Working', timestamp: 3 },
    notification('agent-a', 'resume'),
  ])
  expect(rows.map(row => row.parentToolUseId)).toEqual([undefined, 'launch', undefined, 'other', 'launch', 'launch'])
})
