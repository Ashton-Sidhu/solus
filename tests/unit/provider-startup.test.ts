import { expect, test } from 'bun:test'
import { providerStartupAfter, providerStartupLabel } from '@solus/client-core/provider-startup'
import type { ProviderStartup } from '@solus/contracts/provider-startup'

test('startup continues through init and ends on the first root output', () => {
  const starting: ProviderStartup = { provider: 'claude-code', phase: 'starting' }
  const running = providerStartupAfter(starting, { type: 'status_change', oldStatus: 'connecting', status: 'running' })
  expect(providerStartupAfter(running, { type: 'session_init', sessionId: 'provider-thread', model: 'test', skills: [] })).toBe(starting)

  const connecting: ProviderStartup = { provider: 'claude-code', phase: 'connecting' }
  const phase = providerStartupAfter(running, { type: 'provider_startup', startup: connecting })
  expect(phase).toBe(connecting)
  expect(providerStartupAfter(phase, { type: 'text_chunk', text: 'child', parentToolUseId: 'child-call' })).toBe(connecting)
  expect(providerStartupAfter(phase, { type: 'thinking', state: 'start' })).toBeNull()
  expect(providerStartupAfter(phase, { type: 'text_pending' })).toBeNull()
  expect(providerStartupAfter(phase, { type: 'status_change', oldStatus: 'running', status: 'interrupted' })).toBeNull()
})

test('the label follows the actual provider after model routing', () => {
  const startup = providerStartupAfter({ provider: 'claude-code', phase: 'starting' }, {
    type: 'model_routed', provider: 'codex', modelConfig: { modelId: 'codex-model', reasoningEffort: 'high', contextWindow: null, fastMode: false }, usedFallback: true,
  })
  expect(startup?.provider).toBe('codex')
  expect(providerStartupLabel(startup!)).toContain('Codex')
})
