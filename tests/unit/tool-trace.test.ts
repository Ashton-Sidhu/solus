import { describe, expect, test } from 'bun:test'
import {
  subagentTranscriptText,
  toolTraceInput,
  toolTraceOutput,
  toolTraceStatus,
} from '../../src/renderer/components/conversation/lib/tool-trace'
import type { Message } from '../../src/shared/types'

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
  test('preserves exact inputs and results while formatting JSON for display', () => {
    const message = tool({
      toolInput: '{"file_path":"src/a.ts","limit":20}',
      toolResult: 'line one\nline two\n',
    })

    expect(toolTraceInput(message)).toEqual({
      text: '{\n  "file_path": "src/a.ts",\n  "limit": 20\n}',
      language: 'json',
    })
    expect(toolTraceOutput(message)).toEqual({
      text: 'line one\nline two\n',
      language: 'text',
    })
  })

  test('uses persisted Codex content as output when no separate tool result exists', () => {
    expect(toolTraceOutput(tool({ content: 'command output' }))).toEqual({
      text: 'command output',
      language: 'text',
    })
  })

  test('reports failures and includes the complete observable trace in copied text', () => {
    const failed = tool({
      toolName: 'Bash',
      toolInput: 'false',
      toolResult: 'exit code 1',
      toolResultIsError: true,
      toolStatus: 'error',
    })

    expect(toolTraceStatus(failed)).toBe('Failed')
    expect(subagentTranscriptText([
      failed,
      { id: 'text', role: 'assistant', content: 'Trying another route.', timestamp: 200 } as Message,
    ])).toBe([
      'Tool: Bash',
      'Status: Failed',
      'Call ID: call-1',
      'Input:',
      'false',
      'Error:',
      'exit code 1',
      '',
      'Trying another route.',
    ].join('\n'))
  })
})
