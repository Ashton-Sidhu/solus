import { describe, expect, test } from 'bun:test'
import { sessionTitleRegenerationInput } from '@solus/workspace-ui/contexts/workspace/session-title-regeneration'

describe('session title regeneration input', () => {
  test('uses indexed metadata when the conversation transcript is not mounted', () => {
    // WHY: sidebar and picker rows can exist before their conversation view has
    // loaded, but title regeneration must still work from that closed state.
    expect(sessionTitleRegenerationInput([], '  Add a closed-session fallback  '))
      .toBe('Add a closed-session fallback')
  })

  test('prefers the mounted opening prompt when it is available', () => {
    expect(sessionTitleRegenerationInput([
      { role: 'assistant', content: 'Ready.' },
      { role: 'user', content: '  Use the live transcript  ' },
    ], 'Older indexed text')).toBe('Use the live transcript')
  })

  test('removes a prepended task packet from an indexed opening prompt', () => {
    // WHY: older task-backed sessions stored the complete dispatch prompt in
    // the index. Regeneration must name the user's request, not Solus context.
    const indexedPrompt = [
      '[Working On Task — "Fix titles" (task_id: 01KZ4TSYMQRX31D1DK5AAEW5TR, status: in_progress)]',
      'Keep generated names tied to the user prompt.',
      '',
      'Work contract:',
      '- Keep this task in progress while you work.',
      '',
      'Call read_task with task_id "01KZ4TSYMQRX31D1DK5AAEW5TR" to refresh this packet; use comment_task for durable write-back.',
      '',
      'Keep the user title stable',
    ].join('\n')

    expect(sessionTitleRegenerationInput([], indexedPrompt)).toBe('Keep the user title stable')
  })

  test('removes appended reference context from the mounted prompt', () => {
    const prompt = [
      'Use the selected plan',
      '',
      '[Referenced Plan: "Release" (plan_id: plan-1)]',
    ].join('\n')

    expect(sessionTitleRegenerationInput([{ role: 'user', content: prompt }]))
      .toBe('Use the selected plan')
  })
})
