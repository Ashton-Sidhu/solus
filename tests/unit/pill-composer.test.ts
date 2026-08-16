import { describe, expect, test } from 'bun:test'
import type { AgentId, RunConfig, Session } from '../../src/shared/types'
import type { SessionDraft } from '../../src/renderer/contexts/workspace/session-draft.svelte'
import { pillComposerTarget } from '../../src/renderer/components/layout/lib/pill-composer'
import { draftModelSelection } from '../../src/renderer/components/session-draft/lib/draft-selection'

function run(workingDirectory: string, provider: AgentId | null = null): RunConfig {
  return {
    provider,
    workingDirectory,
    gitContext: null,
    modelConfig: {
      modelId: 'claude-opus-4-1',
      reasoningEffort: 'high',
      contextWindow: null,
      fastMode: false,
    },
  } as RunConfig
}

function draft(runConfig: RunConfig): SessionDraft {
  return { id: 'draft-1', run: runConfig } as SessionDraft
}

function session(): Session {
  return { id: 'session-1', run: run('/repo') } as Session
}

describe('pill composer target', () => {
  test('a draft takes the dock off the tab it covered', () => {
    // WHY: the pill has no route outlet, so a draft never mounts a composer of
    // its own there. If the bar stayed addressed by the active tab, the first
    // message of a new session would be sent into the previous conversation.
    const composing = draft(run('/other-repo'))
    const target = pillComposerTarget(composing, session(), 'tab-1')

    expect(target.sessionId).toBeNull()
    expect(target.tabId).toBeUndefined()
    expect(target.run).toBe(composing.run)
  })

  test('the started conversation keeps the dock when no draft is composing', () => {
    const active = session()
    const target = pillComposerTarget(null, active, 'tab-1')

    expect(target).toMatchObject({ sessionId: 'session-1', tabId: 'tab-1' })
    expect(target.run).toBe(active.run)
  })
})

describe('draft model selection', () => {
  test('picking a model writes into the run the session will start with', () => {
    // WHY: a draft has no session for the model chip to edit, so a choice made
    // before Send is only kept if it lands on the draft's own run.
    const composing = draft(run('/repo'))
    const selection = draftModelSelection(() => composing, () => 'codex')

    selection.provider = 'claude-code'
    selection.modelId = 'claude-sonnet-4-5'
    selection.reasoningEffort = 'low'

    expect(composing.run.provider).toBe('claude-code')
    expect(composing.run.modelConfig.modelId).toBe('claude-sonnet-4-5')
    expect(composing.run.modelConfig.reasoningEffort).toBe('low')
  })

  test('falls back to the app agent until the draft names one', () => {
    const composing = draft(run('/repo'))
    const selection = draftModelSelection(() => composing, () => 'codex')

    expect(selection.provider).toBe('codex')
  })
})
