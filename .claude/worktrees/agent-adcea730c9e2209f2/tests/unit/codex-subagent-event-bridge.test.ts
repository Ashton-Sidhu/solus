import { describe, expect, test } from 'bun:test'
import { CodexSubagentEventBridge } from '../../src/main/agents/codex/codex-subagent-event-bridge'

describe('CodexSubagentEventBridge', () => {
  test('correlates parallel MCP invocations by their complete input', async () => {
    const bridge = new CodexSubagentEventBridge()
    const first = bridge.claim({ prompt: 'Inspect auth', description: 'Auth review' })
    const second = bridge.claim({ prompt: 'Inspect billing', description: 'Billing review' })

    bridge.observe({ type: 'tool_call', toolName: 'mcp__solus__codex_subagent', toolId: 'tool-auth', index: 0 })
    bridge.observe({ type: 'tool_call', toolName: 'mcp__solus__codex_subagent', toolId: 'tool-billing', index: 1 })
    bridge.observe({
      type: 'tool_call_complete',
      index: 1,
      toolInput: JSON.stringify({ prompt: 'Inspect billing', description: 'Billing review' }),
    })
    bridge.observe({
      type: 'tool_call_complete',
      index: 0,
      toolInput: JSON.stringify({ prompt: 'Inspect auth', description: 'Auth review' }),
    })

    expect(await first).toBe('tool-auth')
    expect(await second).toBe('tool-billing')
  })
})
