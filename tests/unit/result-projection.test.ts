import { describe, expect, test } from 'bun:test'
import {
  ERROR_HEAD_MAX_BYTES,
  projectSessionEvent,
  projectSessionHistory,
} from '../../src/main/server/result-projection'

describe('session result projection', () => {
  test('keeps a subagent report whole', () => {
    const text = '# Findings\n\nThe complete answer.'
    expect(projectSessionEvent({
      type: 'tool_result',
      toolUseId: 'agent-1',
      parentToolUseId: 'agent-1',
      content: text,
    })).toEqual({ type: 'subagent_report', toolUseId: 'agent-1', text })
  })

  test('ships no nested tool output', () => {
    const content = 'private output'.repeat(100)
    expect(projectSessionEvent({
      type: 'tool_result',
      toolUseId: 'read-1',
      parentToolUseId: 'agent-1',
      content,
    })).toEqual({
      type: 'tool_result',
      toolUseId: 'read-1',
      parentToolUseId: 'agent-1',
      status: 'ok',
      contentBytes: Buffer.byteLength(content),
    })
  })

  test('caps a failed tool error head by UTF-8 bytes', () => {
    const projected = projectSessionEvent({
      type: 'tool_result',
      toolUseId: 'bash-1',
      content: `Failure\n${'🙂'.repeat(2_000)}`,
      isError: true,
    })
    expect(projected).toMatchObject({ type: 'tool_result', status: 'error' })
    expect(Buffer.byteLength((projected as { errorHead: string }).errorHead)).toBeLessThanOrEqual(ERROR_HEAD_MAX_BYTES)
    expect(projected).not.toHaveProperty('content')
  })

  test('drops Codex aggregated output from a tool update', () => {
    expect(projectSessionEvent({
      type: 'tool_call_update',
      toolId: 'command-1',
      toolInput: 'pwd',
      content: '/Users/sidhu/solus\n',
    })).toEqual({ type: 'tool_call_update', toolId: 'command-1', toolInput: 'pwd' })
  })

  test('keeps a history report and drops an ordinary result', () => {
    const projected = projectSessionHistory([
      {
        role: 'tool',
        content: '',
        toolName: 'Agent',
        toolId: 'agent-1',
        toolInput: '{}',
        isSubagent: true,
        timestamp: 1,
      },
      {
        role: 'tool_result',
        content: 'Complete report',
        toolResultForId: 'agent-1',
        timestamp: 2,
      },
      {
        role: 'tool',
        content: '',
        toolName: 'Read',
        toolId: 'read-1',
        toolInput: '{}',
        timestamp: 3,
      },
      {
        role: 'tool_result',
        content: 'file contents',
        toolResultForId: 'read-1',
        timestamp: 4,
      },
    ])

    expect(projected[1]).toMatchObject({ content: '', report: 'Complete report', status: 'ok' })
    expect(projected[3]).toMatchObject({ content: '', status: 'ok', contentBytes: 13 })
    expect(projected[3]).not.toHaveProperty('report')
  })

  test('extracts agent-conversation correlation without shipping result text', () => {
    const agentSessionId = '11111111-1111-1111-1111-111111111111'
    const projected = projectSessionHistory([
      { role: 'tool', content: '', toolName: 'create_session', toolId: 'create-1', timestamp: 1 },
      {
        role: 'tool_result',
        content: `Created sessionId=${agentSessionId} with private provider output`,
        toolResultForId: 'create-1',
        timestamp: 2,
      },
    ])

    expect(projected[1]).toMatchObject({
      content: '',
      agentConversationResult: { agentSessionId },
    })
  })
})
