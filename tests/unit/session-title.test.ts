import { describe, expect, test } from 'bun:test'
import type { AgentRun, AgentRunRequest } from '@solus/server/agents/agent-runner'
import { generateMetadataWith, sanitizeTitle } from '@solus/server/sessions/session-title'

/** A dispatcher that answers the way a backend would: `submitted` is the title
 *  handed to the capture tool (omitted = the tool is never called), `prose` is
 *  the run's final text. */
function dispatcherAnswering(options: { submitted?: { title: string; description: string }; prose?: string }) {
  const requests: AgentRunRequest[] = []
  return {
    requests,
    runAgent(request: AgentRunRequest): AgentRun {
      requests.push(request)
      const done = (async () => {
        if (options.submitted !== undefined) {
          await request.tools[0].execute(options.submitted as never, {} as never)
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

describe('generateMetadataWith', () => {
  test('takes the name from the tool call, not the prose around it', async () => {
    // WHY: the whole point of submitting through the tool is that a model free
    // to also chat can't get its commentary onto the tab.
    const dispatcher = dispatcherAnswering({
      submitted: {
        title: 'Auth Redirect Loop',
        description: 'Stop the login page from repeatedly redirecting authenticated users.',
      },
      prose: "Sure! I've named it for you.",
    })
    expect(await generateMetadataWith(dispatcher, 'codex', 'the login page loops forever', '/repo'))
      .toEqual({
        title: 'Auth Redirect Loop',
        description: 'Stop the login page from repeatedly redirecting authenticated users.',
      })
  })

  test('rejects unstructured prose instead of using it as a legacy title fallback', async () => {
    // WHY: accepting final prose would create a second naming protocol beside
    // the structured tool and let commentary leak into the session index.
    const dispatcher = dispatcherAnswering({ prose: 'Worktree Cleanup' })
    expect(await generateMetadataWith(dispatcher, 'codex', 'delete stale worktrees', '/repo')).toBeNull()
  })

  test('uses the selected text-generation model at low reasoning effort', async () => {
    // WHY: session metadata follows the host writing preference, not the
    // active session model, while keeping this background task inexpensive.
    const dispatcher = dispatcherAnswering({
      submitted: { title: 'Session Renaming', description: 'Allow users to rename sessions.' },
    })
    await generateMetadataWith(
      dispatcher,
      'codex',
      'let me rename sessions',
      '/repo',
      'gpt-5.5',
    )
    expect(dispatcher.requests[0].model).toBe('gpt-5.5')
    expect(dispatcher.requests[0].reasoningEffort).toBe('low')

    const claude = dispatcherAnswering({
      submitted: { title: 'Session Renaming', description: 'Allow users to rename sessions.' },
    })
    await generateMetadataWith(claude, 'claude-code', 'let me rename sessions', '/repo')
    expect(claude.requests[0].model).toBe('claude-haiku-4-5-20251001')
  })

  test('names the durable subject and excludes incidental workflow instructions', async () => {
    // WHY: session names must stay recognizable after planning, implementation,
    // review, and other temporary workflow steps are complete.
    const dispatcher = dispatcherAnswering({
      submitted: {
        title: 'Session Naming Prompt',
        description: 'Use durable subject and outcome language when naming sessions.',
      },
    })
    await generateMetadataWith(
      dispatcher,
      'codex',
      'use a subagent to make a plan for improving session names',
      '/repo',
    )

    expect(dispatcher.requests[0].prompt).toContain(
      'Title the subject and outcome. Discard incidental instructions.',
    )
    expect(dispatcher.requests[0].prompt).toContain(
      'Name the product change, not the mock, plan, report, branch, or PR used to produce it.',
    )
    expect(dispatcher.requests[0].prompt).toContain(
      'Models, subagents, tools, output formats, and monitoring instructions do not belong in the title',
    )
    expect(dispatcher.requests[0].prompt).toContain(
      'User message:\nuse a subagent to make a plan for improving session names',
    )
  })

  test('passes image content and safe attachment metadata to the naming run', async () => {
    // WHY: a screenshot can be the only place that identifies the UI problem,
    // while its client-local path must not be required by the host.
    const dispatcher = dispatcherAnswering({
      submitted: {
        title: 'Mobile Navigation Overflow',
        description: 'Correct the mobile navigation overflow shown in the attached screenshot.',
      },
    })
    const imageAttachments = [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]
    await generateMetadataWith(
      dispatcher,
      'codex',
      'fix this',
      '/repo',
      undefined,
      {
        attachments: [{ name: 'mobile.png', type: 'image', mimeType: 'image/png', size: 1234 }],
        imageAttachments,
      },
    )

    expect(dispatcher.requests[0].imageAttachments).toEqual(imageAttachments)
    expect(dispatcher.requests[0].maxTurns).toBe(4)
    expect(dispatcher.requests[0].prompt).toContain(
      'Attachment metadata:\n- mobile.png (image, image/png, 1234 bytes)',
    )
    expect(dispatcher.requests[0].prompt).toContain(
      'Use attached images as primary context for UI issues.',
    )
  })

  test('allows linked context inspection before structured submission', async () => {
    // WHY: a link can be the only source that identifies the durable subject.
    const dispatcher = dispatcherAnswering({
      submitted: {
        title: 'Take Over PR 8588',
        description: 'Take over the linked pull request and continue its work.',
      },
    })
    await generateMetadataWith(
      dispatcher,
      'codex',
      'take over https://github.com/example/project/pull/8588',
      '/repo',
    )

    expect(dispatcher.requests[0].maxTurns).toBe(4)
    expect(dispatcher.requests[0].prompt).toContain(
      'When a URL or attachment is the only source of the subject, use available tools to inspect it directly.',
    )
  })
})
