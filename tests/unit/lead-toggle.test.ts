import { describe, expect, test } from 'bun:test'
import { canChooseLead, runForLead } from '@solus/workspace-ui/components/input/lib/lead-toggle'
import { makeRunConfig } from '@solus/workspace-ui/contexts/workspace/session.factories'

/**
 * The Lead choice is made before the first message (docs/plans/lead-session.md):
 * the composer offers it to a draft and to a tab that has not started, and to
 * nothing else. Turning it on starts the session on the lead model when the
 * person set one.
 */

describe('canChooseLead', () => {
  test('a draft can choose', () => {
    expect(canChooseLead(undefined, {})).toBe(true)
  })

  test('a tab with no message and no provider conversation can choose', () => {
    expect(canChooseLead({ messages: [], agentSessionId: null }, undefined)).toBe(true)
  })

  test('a started session cannot', () => {
    expect(canChooseLead({ messages: [{}], agentSessionId: null }, undefined)).toBe(false)
    expect(canChooseLead({ messages: [], agentSessionId: 'thread-1' }, undefined)).toBe(false)
  })
})

describe('runForLead', () => {
  const run = makeRunConfig({ provider: 'claude-code' })

  test('without a lead model the run is unchanged', () => {
    expect(runForLead(run, null)).toBe(run)
  })

  test('with a lead model the run moves to it, keeping the reasoning level named', () => {
    const next = runForLead(run, { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'low' })
    expect(next.provider).toBe('codex')
    expect(next.modelConfig.modelId).toBe('gpt-5.5')
    expect(next.modelConfig.reasoningEffort).toBe('low')
    expect(next.location).toBe(run.location)
  })
})
