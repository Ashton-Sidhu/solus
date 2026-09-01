import { describe, expect, test } from 'bun:test'
import { subagentTranscriptText } from '@solus/workspace-ui/components/conversation/lib/tool-trace'
import type { Message } from '@solus/contracts/types'

function tool(overrides: Partial<Message> = {}): Message {
  return {
    id: 'tool-1',
    role: 'tool',
    content: '',
    toolName: 'Read',
    toolId: 'call-1',
    toolStatus: 'completed',
    timestamp: 100,
    ...overrides,
  } as Message
}

describe('sub-agent tool trace', () => {
  test('copies tool identity and byte count without the omitted output', () => {
    const failed = tool({
      toolName: 'Bash',
      toolInput: 'false',
      contentBytes: 11,
      toolStatus: 'error',
    })

    expect(subagentTranscriptText([
      failed,
      { id: 'text', role: 'assistant', content: 'Trying another route.', timestamp: 200 } as Message,
    ])).toBe([
      'Tool: Bash',
      'Status: Failed',
      'Call ID: call-1',
      'Input:',
      'false',
      'Error: (11 B, not shipped)',
      '',
      'Trying another route.',
    ].join('\n'))
  })
})
