import { describe, expect, test } from 'bun:test'
import { runReviewAgent } from '../../src/main/review/review-agent'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '../../src/main/agents/agent-runner'
import type { AgentToolContext } from '../../src/main/agents/tools/agent-tool'

const guide = {
  title: 'Unified runner',
  summary: 'Routes review generation through the control plane.',
  sections: [],
}

class ReviewDispatcher implements AgentDispatcher {
  request: AgentRunRequest | null = null

  runAgent(request: AgentRunRequest): AgentRun {
    this.request = request
    const context: AgentToolContext = {
      provider: request.provider,
      cwd: request.cwd,
      sessionId: () => undefined,
      abortSignal: new AbortController().signal,
      parentToolUseId: () => undefined,
      emit: () => {},
    }
    return {
      sessionId: Promise.resolve(null),
      done: request.tools[0].execute(guide, context).then(() => ({
        sessionId: null,
        output: '',
        toolCallCount: 1,
        permissionDenials: [],
        exitCode: 0,
        signal: null,
      })),
      cancel() {},
      handle: {} as AgentRun['handle'],
    }
  }
}

describe('review agent control-plane dispatch', () => {
  test.each(['claude-code', 'codex'] as const)('%s selects only submit_review_guide', async (agent) => {
    const dispatcher = new ReviewDispatcher()
    const progress: string[] = []
    const result = await runReviewAgent(dispatcher, {
      workTree: '/tmp/project',
      base: 'HEAD',
      ledger: null,
      context: {
        key: 'review-1',
        branch: 'feature',
        targetBranch: 'main',
        baseSha: 'abc',
        headSha: 'def',
        repoRoot: '/tmp/project',
      },
      agent,
      onProgress: (step) => progress.push(step),
    })

    expect(result).toEqual(guide)
    expect(dispatcher.request?.tools.map(({ name }) => name)).toEqual(['submit_review_guide'])
    expect(dispatcher.request?.permissionMode).toBe('plan')
    expect(dispatcher.request?.persistence).toBe('ephemeral')
    expect(dispatcher.request?.unattended).toBe(true)
    expect(dispatcher.request?.timeoutMs).toBe(10 * 60_000)
    expect(dispatcher.request?.prompt).toContain('The review scope is already decided')
    expect(dispatcher.request?.prompt).toContain('Do not ask the user to choose')
    expect(progress).toEqual(['writing'])
  })
})
