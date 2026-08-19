import { describe, expect, test } from 'bun:test'
import type { MetricsSpan } from '@solus/contracts/observability-types'
import {
  exchangeMeta,
  transcriptAsText,
  transcriptIsEmpty,
  turnTranscript,
  type TranscriptRole,
} from '@solus/workspace-ui/components/insights/lib/turn-transcript'

// The turn's three texts are one exchange, and the panel used to print them as
// three interchangeable cards. These tests hold the reading the model exists to
// give: named roles, the ask beside the answer, and no claim about text the
// capture never stored.

function turn(attrs: MetricsSpan['attrs']): MetricsSpan {
  return {
    spanId: 'root',
    parentSpanId: null,
    traceId: 'tr_1',
    kind: 'turn',
    name: 'turn',
    service: 'solus.sessions',
    sessionId: 's_1',
    provider: 'claude',
    model: 'claude-fable-5',
    projectRoot: '/repo',
    origin: 'typed',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    status: 'ok',
    attrs,
  }
}

function pane(panes: ReturnType<typeof turnTranscript>, role: TranscriptRole) {
  const found = panes.find((candidate) => candidate.role === role)
  if (!found) throw new Error(`no ${role} pane`)
  return found
}

describe('turn transcript', () => {
  test('puts the ask beside the answer and the instructions last', () => {
    // WHY: chronological order would lead with the largest text a turn carries.
    // The pair a reader compares is prompt and response, so they stay adjacent.
    const panes = turnTranscript(
      turn({ prompt: 'ship it', response: 'shipped', systemPrompt: 'you are Solus' }),
    )

    expect(panes.map((entry) => entry.role)).toEqual(['prompt', 'response', 'system'])
  })

  test('names the speakers, not the attributes they were read from', () => {
    // WHY: the card reads as one exchange; a reader scanning it should not have
    // to translate "Prompt" and "Response" back into who spoke. The answer is
    // named for the backend that gave it, because comparing agent backends is
    // what this page is for.
    const panes = turnTranscript(turn({ prompt: 'ship it', response: 'shipped' }))

    expect(pane(panes, 'prompt').label).toBe('User')
    expect(pane(panes, 'prompt').mark).toBe('user')
    expect(pane(panes, 'response').label).toBe('Claude Code')
    expect(pane(panes, 'response').mark).toBe('claude')
    expect(pane(panes, 'system').label).toBe('System prompt')
    expect(pane(panes, 'system').mark).toBeNull()
  })

  test('an uncaptured backend is named "Agent" and shows no logo', () => {
    // WHY: a missing provider must not be drawn as somebody's brand. Both spellings
    // of Claude Code are one speaker; Codex is its own.
    const codex = turnTranscript({ ...turn({ response: 'done' }), provider: 'codex' })
    expect(pane(codex, 'response').label).toBe('Codex')
    expect(pane(codex, 'response').mark).toBe('codex')

    const legacy = turnTranscript({ ...turn({ response: 'done' }), provider: 'claude-code' })
    expect(pane(legacy, 'response').label).toBe('Claude Code')

    const unknown = turnTranscript({ ...turn({ response: 'done' }), provider: null })
    expect(pane(unknown, 'response').label).toBe('Agent')
    expect(pane(unknown, 'response').mark).toBeNull()
  })

  test('the header states the size of the exchange, and stays silent when unmeasured', () => {
    // WHY: the two counts belong on one line above the exchange, not as chrome
    // on each role's own row — and an unmeasured turn must not read as "0 in".
    const measured = turnTranscript(
      turn({ prompt: 'p', inputTokens: 1_200, outputTokens: 340, systemPromptChars: 900 }),
    )
    expect(exchangeMeta(measured)).toBe('1.2k in · 340 out')

    // The instructions' character count is not part of the exchange's size.
    expect(exchangeMeta(turnTranscript(turn({ systemPromptChars: 900 })))).toBeNull()
    expect(exchangeMeta(turnTranscript(turn({ prompt: 'p' })))).toBeNull()
  })

  test('names what each text is made of, and says nothing when the count is absent', () => {
    // WHY: a "0 in" beside a prompt is a measurement the capture never took.
    const measured = turnTranscript(turn({ prompt: 'p', inputTokens: 1_200, outputTokens: 340 }))
    expect(pane(measured, 'prompt').meta).toBe('1.2k in')
    expect(pane(measured, 'response').meta).toBe('340 out')

    const unmeasured = turnTranscript(turn({ prompt: 'p' }))
    expect(pane(unmeasured, 'prompt').meta).toBeNull()
    expect(pane(unmeasured, 'response').meta).toBeNull()
    expect(pane(unmeasured, 'system').meta).toBeNull()
  })

  test('carries the capture cap, so a clipped answer cannot read as a short one', () => {
    const panes = turnTranscript(
      turn({ response: 'half an answer', responseTruncated: true, responseChars: 48_000 }),
    )

    expect(pane(panes, 'response').truncated).toBe(true)
    expect(pane(panes, 'response').chars).toBe(48_000)
    expect(pane(panes, 'prompt').truncated).toBe(false)
  })

  test('an unrecorded text keeps its pane and states why it is empty', () => {
    // WHY: a missing system prompt is a fact about when capture started, not a
    // failure of this turn — dropping the pane hides the difference.
    const panes = turnTranscript(turn({ prompt: 'ship it' }))

    expect(pane(panes, 'system').text).toBe('')
    expect(pane(panes, 'system').emptyNote).toContain('before the instructions were instrumented')
    expect(transcriptIsEmpty(panes)).toBe(false)
    expect(transcriptIsEmpty(turnTranscript(null))).toBe(true)
  })

  test('copying the turn names the roles and skips what was never stored', () => {
    const panes = turnTranscript(turn({ prompt: 'ship it', response: 'shipped' }))

    expect(transcriptAsText(panes)).toBe('## User\n\nship it\n\n## Claude Code\n\nshipped')
  })

  test('a non-string attribute is not printed as text', () => {
    // WHY: attrs is a loose value bag; String(42) in a prompt pane would render
    // a number as the user's message.
    const panes = turnTranscript(turn({ prompt: 42 }))

    expect(pane(panes, 'prompt').text).toBe('')
  })
})
