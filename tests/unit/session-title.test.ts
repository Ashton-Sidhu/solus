import { describe, expect, test } from 'bun:test'
import type { AgentRun, AgentRunRequest } from '../../src/main/agents/agent-runner'
import { generateTitleWith, sanitizeTitle } from '../../src/main/sessions/session-title'

/** A dispatcher that answers the way a backend would: `submitted` is the title
 *  handed to the capture tool (omitted = the tool is never called), `prose` is
 *  the run's final text. */
function dispatcherAnswering(options: { submitted?: string; prose?: string }) {
  const requests: AgentRunRequest[] = []
  return {
    requests,
    runAgent(request: AgentRunRequest): AgentRun {
      requests.push(request)
      const done = (async () => {
        if (options.submitted !== undefined) {
          await request.tools[0].execute({ title: options.submitted } as never, {} as never)
        }
        return {
          sessionId: null,
          output: options.prose ?? '',
          toolCallCount: options.submitted === undefined ? 0 : 1,
          permissionDenials: [],
          exitCode: 0,
          signal: null,
        }
      })()
      return { sessionId: Promise.resolve(null), done, cancel: () => {}, handle: {} as never }
    },
  }
}

// A generated name goes straight onto a tab and into the session index, so what
// matters is that a chat model's habits — a preamble, a code fence, a bullet, a
// trailing period, an essay — never reach the UI as the session's name.
describe('sanitizeTitle', () => {
  test('keeps a clean one-line answer as-is', () => {
    expect(sanitizeTitle('Dark Mode Toggle')).toBe('Dark Mode Toggle')
  })

  test('strips the ways a model dresses up a one-line answer', () => {
    expect(sanitizeTitle('```\nAuth Redirect Loop\n```')).toBe('Auth Redirect Loop')
    expect(sanitizeTitle('- **Session Renaming**')).toBe('Session Renaming')
    expect(sanitizeTitle('Title: "Worktree Cleanup."')).toBe('Worktree Cleanup')
  })

  test('takes the first real line when the model narrates first', () => {
    expect(sanitizeTitle('\n\nRate Limit Backoff\nLet me know if you want another.')).toBe('Rate Limit Backoff')
  })

  test('caps a runaway answer so it cannot blow out a tab', () => {
    const long = sanitizeTitle('Refactor The Entire Session Indexer And Its Migrations For Titles')
    expect(long!.length).toBeLessThanOrEqual(48)
  })

  test('reports nothing usable rather than an empty name', () => {
    expect(sanitizeTitle('   \n  ')).toBeNull()
    expect(sanitizeTitle('""')).toBeNull()
  })
})

describe('generateTitleWith', () => {
  test('takes the name from the tool call, not the prose around it', async () => {
    // WHY: the whole point of submitting through the tool is that a model free
    // to also chat can't get its commentary onto the tab.
    const dispatcher = dispatcherAnswering({
      submitted: 'Auth Redirect Loop',
      prose: "Sure! I've named it for you.",
    })
    expect(await generateTitleWith(dispatcher, 'codex', 'the login page loops forever', '/repo'))
      .toBe('Auth Redirect Loop')
  })

  test('falls back to the answer text when the model never calls the tool', async () => {
    // Codex drops custom tools on older CLIs, so text has to stay a live path.
    const dispatcher = dispatcherAnswering({ prose: 'Worktree Cleanup' })
    expect(await generateTitleWith(dispatcher, 'codex', 'delete stale worktrees', '/repo'))
      .toBe('Worktree Cleanup')
  })

  test('names the run with the backend\'s cheap model at its lowest effort', async () => {
    // WHY: naming a thread is a chore, not a turn — it must never draft the
    // session's real model or spend reasoning tokens on a five-word answer.
    const dispatcher = dispatcherAnswering({ submitted: 'Session Renaming' })
    await generateTitleWith(dispatcher, 'codex', 'let me rename sessions', '/repo')
    expect(dispatcher.requests[0].model).toBe('gpt-5.6-luna')
    expect(dispatcher.requests[0].reasoningEffort).toBe('low')

    const claude = dispatcherAnswering({ submitted: 'Session Renaming' })
    await generateTitleWith(claude, 'claude-code', 'let me rename sessions', '/repo')
    expect(claude.requests[0].model).toBe('claude-haiku-4-5-20251001')
  })
})
