import { describe, expect, test } from 'bun:test'
import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent } from '@solus/contracts/types'
import { PermissionManager } from '@solus/server/execution/agents/claude/claude-permissions'

// Without an onElicitation callback the Agent SDK declines every MCP
// elicitation, so the user never sees the server's confirmation. Claude must
// show the same question card as Codex and answer through the same path.

const formRequest: ElicitationRequest = {
  serverName: 'deploy',
  message: 'Confirm the deploy',
  mode: 'form',
  requestedSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', title: 'Deploy to production?' },
      note: { type: 'string', title: 'Note' },
    },
    required: ['confirm'],
  },
}

function setup(sessionId: string | null = 'session-1', unattended = false) {
  const manager = new PermissionManager()
  const events: Array<{ sessionId: string | null; event: NormalizedEvent }> = []
  manager.onPermissionEvent = (eventSessionId, event) => events.push({ sessionId: eventSessionId, event })
  const onElicitation = manager.createOnElicitation({ current: sessionId }, unattended)
  return { manager, events, onElicitation }
}

function questionOf(events: Array<{ event: NormalizedEvent }>): Extract<NormalizedEvent, { type: 'question_request' }> {
  const event = events.find((entry) => entry.event.type === 'question_request')?.event
  if (event?.type !== 'question_request') throw new Error('no question card')
  return event
}

describe('Claude MCP elicitation', () => {
  test('a form request shows the MCP card and the answer reaches the server as typed content', async () => {
    const { manager, events, onElicitation } = setup()
    const result = onElicitation(formRequest, { signal: new AbortController().signal, requestId: 'r1' })

    const question = questionOf(events)
    expect(events[0].sessionId).toBe('session-1')
    expect(question.kind).toBe('mcp_form')
    expect(question.questions.map((q) => q.id)).toEqual(['confirm', 'note'])

    expect(manager.respondToQuestion(question.questionId, { __action: 'accept', confirm: 'true', note: '' })).toBe(true)
    expect(await result).toEqual({ action: 'accept', content: { confirm: true } })
  })

  test('declining on the card declines the request', async () => {
    const { manager, events, onElicitation } = setup()
    const result = onElicitation(formRequest, { signal: new AbortController().signal, requestId: 'r1' })
    manager.respondToQuestion(questionOf(events).questionId, { __action: 'decline' })
    expect(await result).toEqual({ action: 'decline' })
  })

  test('a url request shows the URL card and accepts without content', async () => {
    const { manager, events, onElicitation } = setup()
    const result = onElicitation(
      { serverName: 'auth', message: 'Sign in', mode: 'url', url: 'https://example.com/auth', elicitationId: 'e1' },
      { signal: new AbortController().signal, requestId: 'r1' },
    )
    const question = questionOf(events)
    expect(question).toMatchObject({ kind: 'mcp_url', url: 'https://example.com/auth', serverName: 'auth' })
    manager.respondToQuestion(question.questionId, { __action: 'accept' })
    expect(await result).toEqual({ action: 'accept', content: { elicitationId: 'e1' } })
  })

  test('Stop or the end of the run cancels a request that is still open', async () => {
    const { manager, events, onElicitation } = setup()
    const result = onElicitation(formRequest, { signal: new AbortController().signal, requestId: 'r1' })
    manager.clearPendingForSession('other-session')
    manager.clearPendingForSession('session-1')
    expect(await result).toEqual({ action: 'cancel' })
    expect(manager.respondToQuestion(questionOf(events).questionId, { __action: 'accept' })).toBe(false)
  })

  test('a request the SDK aborts is cancelled and its card is taken down', async () => {
    const { manager, events, onElicitation } = setup()
    const controller = new AbortController()
    const result = onElicitation(formRequest, { signal: controller.signal, requestId: 'r1' })
    const { questionId } = questionOf(events)
    controller.abort()
    expect(await result).toEqual({ action: 'cancel' })
    expect(events.at(-1)?.event).toEqual({ type: 'permission_resolved', questionId })
    expect(manager.respondToQuestion(questionId, { __action: 'accept' })).toBe(false)
  })

  test('an unattended run declines at once instead of waiting on a hidden card', async () => {
    const { events, onElicitation } = setup('session-1', true)
    expect(await onElicitation(formRequest, { signal: new AbortController().signal, requestId: 'r1' })).toEqual({ action: 'decline' })
    expect(events).toEqual([])
  })
})
