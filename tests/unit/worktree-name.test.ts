import { describe, expect, test } from 'bun:test'
import type { AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { generateWorktreeNameWith } from '@solus/server/git/worktree-name'
import { DEFAULT_WORKTREE_BRANCH_NAMING, generatedWorktreeBranchName } from '@solus/contracts/worktree-branch-naming'

function dispatcherSubmitting(name?: string, failure?: Error) {
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
        if (failure) throw failure
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
    expect(generatedWorktreeBranchName('Stable Session Reconnect', { naming: DEFAULT_WORKTREE_BRANCH_NAMING, user: null }, '0a1b2c3d'))
      .toBe('solus/stable-session-reconnect')
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
    // WHY: the worktree then keeps its temporary branch instead of putting
    // model prose into a Git ref.
    const dispatcher = dispatcherSubmitting()
    expect(await generateWorktreeNameWith(
      dispatcher,
      'repair reconnect handling',
      '/repo',
      { provider: 'codex', model: 'gpt-5.6-luna' },
    )).toBeNull()
  })

  test('keeps a submitted name when the run then ends in an error', async () => {
    // WHY: Claude ends a two-turn run with error_max_turns after the tool
    // call. The name is already correct, so the branch must still be renamed.
    const dispatcher = dispatcherSubmitting('Diagnose slow remote settling', new Error('Reached maximum number of turns (2)'))
    expect(await generateWorktreeNameWith(
      dispatcher,
      'why does settling a remote session take so long',
      '/repo',
      { provider: 'claude-code', model: 'claude-haiku-5-5' },
    )).toBe('Diagnose slow remote settling')
  })

  test('keeps the naming tool out of tool search', async () => {
    // WHY: a deferred tool spends the first of the run's two turns on tool
    // search, and the run then ends at its turn limit.
    const dispatcher = dispatcherSubmitting('Stable Session Reconnect')
    await generateWorktreeNameWith(dispatcher, 'repair reconnect handling', '/repo', { provider: 'claude-code', model: 'claude-haiku-5-5' })
    expect(dispatcher.requests[0].tools[0].alwaysLoad).toBe(true)
  })
})
