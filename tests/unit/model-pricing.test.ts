import { describe, expect, test } from 'bun:test'
import { MODEL_PROFILES } from '../../src/shared/types'
import {
  CODEX_TOKEN_PRICING,
  codexTokenCostUsd,
} from '../../src/main/observability/model-pricing'

describe('Codex token pricing', () => {
  test('has a static price entry for every supported Codex model', () => {
    // WHY: adding a selectable model without pricing must not make its cost
    // silently disappear from Insights.
    expect(Object.keys(CODEX_TOKEN_PRICING).sort()).toEqual(
      Object.keys(MODEL_PROFILES.codex ?? {}).sort(),
    )
  })

  test('prices uncached, cached, cache-write, and output tokens separately', () => {
    expect(codexTokenCostUsd('gpt-5.6-sol', {
      inputTokens: 100_000,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 10_000,
      outputTokens: 20_000,
    })).toBeCloseTo(1.2125, 10)
  })

  test('uses the long-context rate after the published input threshold', () => {
    expect(codexTokenCostUsd('gpt-5.5', {
      inputTokens: 272_001,
      outputTokens: 10_000,
    })).toBeCloseTo(3.17001, 10)
  })

  test('returns no cost for a model missing from the static catalog', () => {
    expect(codexTokenCostUsd('future-model', { inputTokens: 1_000 })).toBeUndefined()
  })
})
