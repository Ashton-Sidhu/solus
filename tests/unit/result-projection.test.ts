import { describe, expect, test } from 'bun:test'
import { formatExchangeTag } from '@solus/contracts/session-exchange'
import {
  ERROR_HEAD_MAX_BYTES,
  projectSessionEvent,
  projectSessionHistory,
  withExchangeProgress,
} from '@solus/server/data/sessions/result-projection'

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

  test('an artifact receipt names the content version its call wrote', () => {
    // WHY: a call that passed html_path has no HTML in its input. On reload the
    // client rebuilds its card from the revision at this version; without it the
    // card would show nothing, or today's body instead of what the call wrote.
    const projected = projectSessionHistory([
      { role: 'tool', content: '', toolName: 'mcp__solus__render_artifact', toolId: 'render-1', timestamp: 1 },
      { role: 'tool_result', content: 'Rendered "Latency" in the conversation and saved it as an artifact (id: w-1). Revise it with update_work.', toolResultForId: 'render-1', timestamp: 2 },
      { role: 'tool', content: '', toolName: 'update_work', toolId: 'update-1', timestamp: 3 },
      { role: 'tool_result', content: 'Updated "Latency" (artifact, id: w-1). New content_version: 4.', toolResultForId: 'update-1', timestamp: 4 },
    ])

    expect(projected[1].artifactWorkRef).toEqual({ workId: 'w-1', title: 'Latency', contentVersion: 1 })
    expect(projected[3].artifactWorkRef).toEqual({ workId: 'w-1', title: 'Latency', contentVersion: 4 })
  })

  test('extracts agent-conversation correlation without shipping result text', () => {
    const agentSessionId = '11111111-1111-1111-1111-111111111111'
    const projected = projectSessionHistory([
      { role: 'tool', content: '', toolName: 'start_session', toolId: 'create-1', timestamp: 1 },
      {
        role: 'tool_result',
        content: `Created a session with private provider output.\n${formatExchangeTag({ messageId: 'm1', agentSessionId, provider: 'codex' })}`,
        toolResultForId: 'create-1',
        timestamp: 2,
      },
    ])

    expect(projected[1]).toMatchObject({
      content: '',
      agentConversationResult: { agentSessionId, messageId: 'm1', provider: 'codex' },
    })
  })

  test("stamps each exchange a page names with the host's word as of the read", () => {
    // WHY: a card rebuilt from history must show where its exchange stands now,
    // not where the transcript left it, without a second lookup that can miss.
    const rows = [
      { role: 'tool' as const, content: '', timestamp: 1, agentConversationResult: { agentSessionId: 'child', messageId: 'running' } },
      { role: 'tool' as const, content: '', timestamp: 2, agentConversationResult: { agentSessionId: 'child', messageId: 'gone' } },
      { role: 'assistant' as const, content: 'prose', timestamp: 3 },
    ]
    const stamped = withExchangeProgress(rows, (exchangeId) => exchangeId === 'running' ? { state: 'running' } : undefined)
    expect(stamped[0]!.agentConversationResult).toEqual({ agentSessionId: 'child', messageId: 'running', progress: { state: 'running' } })
    // One the host no longer carries stays unstamped; the client reads it as lost.
    expect(stamped[1]!.agentConversationResult).toEqual({ agentSessionId: 'child', messageId: 'gone' })
    expect(stamped[2]).toBe(rows[2])
    // A cached page is never changed in place: the next read stamps afresh.
    expect(rows[0]!.agentConversationResult).toEqual({ agentSessionId: 'child', messageId: 'running' })
  })
})
