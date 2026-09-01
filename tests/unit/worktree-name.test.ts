import { describe, expect, test } from 'bun:test'
import type { AgentRun, AgentRunRequest } from '@solus/server/agents/agent-runner'
import { generateWorktreeNameWith } from '@solus/server/git/worktree-name'
import { worktreeBranchName } from '@solus/server/git/worktree-branch-name'

function dispatcherSubmitting(name?: string) {
  const requests: AgentRunRequest[] = []
  return {
    requests,
    runAgent(request: AgentRunRequest): AgentRun {
      requests.push(request)
      const done = (async () => {
        if (name !== undefined) {
          // SAFETY: The capture tool does not read its execution context in this test.
          const unusedContext = {} as never
          await request.tools[0].execute({ name }, unusedContext)
        }
        return {
          sessionId: null,
          output: '',
          toolCallCount: name === undefined ? 0 : 1,
          permissionDenials: [],
          exitCode: 0,
          signal: null,
        }
      })()
      // SAFETY: TextGenerator reads only sessionId, done, and cancel from this test run.
      return { sessionId: Promise.resolve(null), done, cancel: () => {}, handle: {} as never }
    },
  }
}

describe('worktree name generation', () => {
  test('uses the generated name instead of the prompt for the Git branch', () => {
    // WHY: the text-generation round trip has no effect unless its semantic
    // answer, rather than the original prompt, becomes the branch slug.
    expect(worktreeBranchName(
      'please investigate why reconnect sometimes loses the selected host',
      'Stable Session Reconnect',
    )).toMatch(/^solus\/stable-session-reconnect-[a-z0-9]{5}$/)
  })

  test('waits for a structured semantic name from the selected text-generation model', async () => {
    // WHY: Git naming must follow the host writing preference instead of the
    // active chat model or the opening prompt's first 40 characters.
    const dispatcher = dispatcherSubmitting('Stable Session Reconnect')
    const result = await generateWorktreeNameWith(
      dispatcher,
      'please investigate why reconnect sometimes loses the selected host',
      '/repo',
      { provider: 'codex', model: 'gpt-5.6-luna' },
    )

    expect(result).toBe('Stable Session Reconnect')
    expect(dispatcher.requests[0].model).toBe('gpt-5.6-luna')
    expect(dispatcher.requests[0].reasoningEffort).toBe('low')
    expect(dispatcher.requests[0].unattended).toBe(true)
  })

  test('returns null when the model does not submit a name', async () => {
    // WHY: the worktree creator can then use its deterministic prompt-slug
    // fallback instead of putting model prose into a Git ref.
    const dispatcher = dispatcherSubmitting()
    expect(await generateWorktreeNameWith(
      dispatcher,
      'repair reconnect handling',
      '/repo',
      { provider: 'codex', model: 'gpt-5.6-luna' },
    )).toBeNull()
  })
})
