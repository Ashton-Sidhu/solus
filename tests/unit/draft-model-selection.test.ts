import { describe, expect, test } from 'bun:test'
import type { AgentId, RunConfig } from '@solus/contracts/types'
import type { SessionDraft } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'
import { draftModelSelection } from '@solus/workspace-ui/components/session-draft/lib/draft-selection'

function draft(provider: AgentId | null = null): SessionDraft {
  return {
    id: 'draft-1',
    run: {
      provider,
      workingDirectory: '/repo',
      gitContext: null,
      modelConfig: {
        modelId: 'claude-opus-4-1',
        reasoningEffort: 'high',
        contextWindow: null,
        fastMode: false,
      },
    } as RunConfig,
  } as SessionDraft
}

describe('draft model selection', () => {
  test('picking a model writes into the run the session will start with', () => {
    // WHY: a draft has no session for the model chip to edit. Both composers a
    // draft appears in — the editor pane and the pill dock — share these
    // accessors, so a choice made before Send is only kept if it lands here.
    const composing = draft()
    const selection = draftModelSelection(() => composing, () => 'codex')

    selection.provider = 'claude-code'
    selection.modelId = 'claude-sonnet-4-5'
    selection.reasoningEffort = 'low'

    expect(composing.run.provider).toBe('claude-code')
    expect(composing.run.modelConfig.modelId).toBe('claude-sonnet-4-5')
    expect(composing.run.modelConfig.reasoningEffort).toBe('low')
  })

  test('a write hands the draft a new run instead of editing the one it holds', () => {
    // WHY: the draft owns its run. A chip that edits that object in place is
    // writing through state it does not own — Svelte rejects it
    // (ownership_invalid_mutation) and the owner never learns of the change.
    const composing = draft()
    const runBefore = composing.run
    const configBefore = composing.run.modelConfig
    const selection = draftModelSelection(() => composing, () => 'codex')

    selection.fastMode = true

    expect(composing.run.modelConfig.fastMode).toBe(true)
    expect(composing.run).not.toBe(runBefore)
    expect(configBefore.fastMode).toBe(false)
  })

  test('falls back to the app agent until the draft names one', () => {
    expect(draftModelSelection(() => draft(), () => 'codex').provider).toBe('codex')
  })
})
