import { describe, expect, test } from 'bun:test'
import { DEFAULT_PERSONAL_SETTINGS, EXECUTION_PREFERENCE_KEYS, PERSONAL_SETTING_SCHEMAS } from '@solus/contracts/settings'
import { MANAGED_SESSION_SETTING_KEYS, validatePolicyDocument } from '@solus/contracts/policy'
import type { AgentMetadata } from '@solus/contracts/types'
import { initialFallbackModel } from '../../packages/workspace-ui/src/components/settings/lib/worker-models'

// WHY: the fallback model is the person's setting, so the host reads it from
// the turn as it reads the worker model, and an organization can lock it. With
// no fallback set nothing changes. A fallback is for when the default provider
// is out of usage, so the switch turns it on with another provider.

function agent(id: 'claude-code' | 'codex', defaultModel: string): AgentMetadata {
  // SAFETY: the helper reads only the id and the default model.
  return { id, defaultModel } as AgentMetadata
}

describe('the fallback model setting', () => {
  test('is off by default, travels with each turn, and can be locked by a policy', () => {
    expect(DEFAULT_PERSONAL_SETTINGS.fallbackModel).toBeNull()
    expect(EXECUTION_PREFERENCE_KEYS).toContain('fallbackModel')
    expect(MANAGED_SESSION_SETTING_KEYS).toContain('fallbackModel')
    expect(PERSONAL_SETTING_SCHEMAS.fallbackModel.safeParse({ provider: 'opencode', model: 'x' }).success).toBe(false)
  })

  test('a locked fallback must name an allowed provider', () => {
    const document = {
      schemaVersion: 1,
      organization: { name: 'Globex' },
      sessions: {
        settings: { fallbackModel: { provider: 'codex', model: 'gpt-6' } },
        limits: { providers: { allowed: ['claude-code'] } },
      },
    }
    const validation = validatePolicyDocument(document, 'organization')
    expect(validation.ok).toBe(false)
  })

  test('the switch turns it on with a provider other than the default one', () => {
    const agents = [agent('claude-code', 'claude-opus'), agent('codex', 'gpt-6')]
    expect(initialFallbackModel(agents, 'claude-code')).toMatchObject({ provider: 'codex', model: 'gpt-6' })
    expect(initialFallbackModel(agents, 'codex')).toMatchObject({ provider: 'claude-code', model: 'claude-opus' })
    expect(initialFallbackModel([agents[0]!], 'claude-code')).toMatchObject({ provider: 'claude-code' })
    expect(initialFallbackModel([], 'codex')).toBeNull()
  })
})
