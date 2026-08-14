import { describe, expect, test } from 'bun:test'
import type { IpcContext, RunConfig } from '../../src/shared/types'
import { draftPluginCommandScope } from '../../src/renderer/components/session-draft/lib/plugin-command-scope'

function run(provider: RunConfig['provider'], modelId: string): RunConfig {
  return {
    provider,
    workingDirectory: '/repo',
    gitContext: null,
    modelConfig: {
      modelId,
      reasoningEffort: 'high',
      contextWindow: null,
      fastMode: false,
    },
  } as RunConfig
}

function context(): IpcContext {
  return {
    session: {
      provider: null,
      preferredModel: null,
    },
  } as IpcContext
}

describe('draft plugin command scope', () => {
  test('uses the provider and model selected in the draft picker', () => {
    // WHY: a draft has no session cache. Command discovery must follow its own
    // picker instead of the active tab, or Claude skills remain under Codex.
    const claude = draftPluginCommandScope(
      run('claude-code', 'claude-opus-4-1'),
      'codex',
      'draft-1',
      context,
    )
    const codex = draftPluginCommandScope(
      run('codex', 'gpt-5.6-codex'),
      'claude-code',
      'draft-1',
      context,
    )

    expect(claude.context.session).toMatchObject({
      provider: 'claude-code',
      preferredModel: 'claude-opus-4-1',
    })
    expect(codex.context.session).toMatchObject({
      provider: 'codex',
      preferredModel: 'gpt-5.6-codex',
    })
  })

  test('uses the app provider only when the draft has no explicit provider', () => {
    // WHY: restored legacy drafts can omit their provider, but they must still
    // resolve commands deterministically before the first prompt starts.
    const scope = draftPluginCommandScope(
      run(null, 'gpt-5.6-codex'),
      'codex',
      'draft-1',
      context,
    )

    expect(scope.provider).toBe('codex')
    expect(scope.context.session.provider).toBe('codex')
  })
})
