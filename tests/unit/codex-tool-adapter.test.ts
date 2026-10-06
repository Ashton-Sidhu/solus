import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { CodexToolDispatcher, adaptCodexTools } from '@solus/server/execution/agents/codex/codex-tool-adapter'

describe('Codex dynamic tool adapter', () => {
  test('defers ordinary tools while keeping essential guidance visible', () => {
    const tools: AgentTool[] = ['ordinary_tool', 'start_session'].map((name) => ({
      name, description: name, inputFields: {}, requiresApproval: false,
      alwaysLoad: name === 'start_session', execute: async () => ({ ok: true, text: '' }),
    }))
    expect(adaptCodexTools(tools)).toMatchObject([{
      type: 'namespace', name: 'solus', tools: [
        { type: 'function', name: 'ordinary_tool', deferLoading: true },
        { type: 'function', name: 'start_session', deferLoading: false },
      ],
    }])
    expect(adaptCodexTools([])).toEqual([])
  })

  test('returns a terminal failure when a tool throws', async () => {
    const tool: AgentTool = {
      name: 'failing_tool',
      description: 'Fails for the test.',
      inputFields: { value: z.string() },
      requiresApproval: false,
      execute: async () => {
        throw new Error('The review target could not be prepared.')
      },
    }
    const context: AgentToolContext = {
      provider: 'codex',
      cwd: '/repo',
      sessionId: () => 'solus-session',
      parentToolUseId: () => undefined,
      abortSignal: new AbortController().signal,
      emit: () => {},
    }
    const dispatcher = new CodexToolDispatcher([tool], context)

    expect(await dispatcher.execute('failing_tool', { value: 'test' })).toEqual({
      ok: false,
      text: 'The review target could not be prepared.',
    })
  })
})

// WHY: Codex reads the tool's JSON schema. Written for the output side, it
// marked a field with a default as required, so the model was asked for a
// value it need not send. The input side leaves it optional.
describe('the schema Codex reads', () => {
  test('marks a field with a default as optional', () => {
    const tool: AgentTool = {
      name: 'schema_tool',
      description: 'For the test.',
      inputFields: { prompt: z.string(), report: z.boolean().default(true) },
      requiresApproval: false,
      execute: async () => ({ ok: true, text: '' }),
    }
    const [adapted] = adaptCodexTools([tool])[0]!.tools
    expect(adapted!.inputSchema).toMatchObject({ required: ['prompt'] })
  })
})

// WHY: Codex must see the same screenshot Claude sees (plan 016, P09).
describe('Codex tool results with an image', () => {
  test('the PNG travels as an inputImage data URL after the text', async () => {
    const { codexToolContentItems } = await import('@solus/server/execution/agents/codex/codex-tool-adapter')
    expect(codexToolContentItems('Screenshot', { mimeType: 'image/png', data: 'iVBORw0KGgo=' })).toEqual([
      { type: 'inputText', text: 'Screenshot' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ])
    expect(codexToolContentItems('text only')).toEqual([{ type: 'inputText', text: 'text only' }])
  })
})
