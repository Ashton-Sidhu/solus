import { describe, expect, test } from 'bun:test'
import { TextGenerator } from '../../src/main/agents/text-generator'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '../../src/main/agents/agent-runner'

class CapturingDispatcher implements AgentDispatcher {
  requests: AgentRunRequest[] = []

  runAgent(request: AgentRunRequest): AgentRun {
    this.requests.push(request)
    return {
      sessionId: Promise.resolve(null),
      done: Promise.resolve({
        sessionId: null,
        output: `${request.provider} output`,
        toolCallCount: 0,
        permissionDenials: [],
        exitCode: 0,
        signal: null,
      }),
      cancel() {},
      handle: {} as AgentRun['handle'],
    }
  }
}

describe('TextGenerator control-plane dispatch', () => {
  test.each(['claude-code', 'codex'] as const)('%s uses a tool-free ephemeral run', async (provider) => {
    const dispatcher = new CapturingDispatcher()
    const generator = new TextGenerator(dispatcher)

    await expect(generator.generate({
      provider,
      prompt: 'Name this branch',
      cwd: '/tmp/project',
      systemPrompt: 'Return only a branch name.',
      timeoutMs: 25,
      maxTurns: 2,
    })).resolves.toBe(`${provider} output`)

    expect(dispatcher.requests).toHaveLength(1)
    const request = dispatcher.requests[0]
    expect(request.tools).toEqual([])
    expect(request.persistence).toBe('ephemeral')
    expect(request.timeoutMs).toBe(25)
    expect(request.maxTurns).toBe(2)
    expect(request.systemPrompt).toContain('Return only a branch name.')
    expect('gitContext' in request).toBe(false)
    expect('sessionChangedFiles' in request).toBe(false)
    expect('extraInstructions' in request).toBe(false)
    expect('modelInstructions' in request).toBe(false)
  })
})
