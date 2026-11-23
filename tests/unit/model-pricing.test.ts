import { describe, expect, test } from 'bun:test'
import { MODEL_PROFILES } from '@solus/contracts/types'
import {
  CODEX_TOKEN_PRICING,
  codexTokenCostUsd,
} from '@solus/server/execution/observability/model-pricing'

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

  test('uses the long-context rate when a request passes the published input threshold', () => {
    expect(codexTokenCostUsd('gpt-5.5', {
      inputTokens: 272_001,
      outputTokens: 10_000,
    }, 272_001)).toBeCloseTo(3.17001, 10)
  })

  test("a turn's many small requests are billed at the standard rate, however large their sum", () => {
    // WHY: a Codex turn sums every request it made. One turn here read 22M
    // cached tokens in requests of ~130K; at the long-context rate its cost doubled.
    const usage = { inputTokens: 300_000, cacheReadTokens: 20_000_000, outputTokens: 40_000 }
    expect(codexTokenCostUsd('gpt-6.2-astra', usage, 130_000)).toBeCloseTo((300_000 * 8 + 20_000_000 * 0.4 + 40_000 * 40) / 1_000_000, 10)
    expect(codexTokenCostUsd('gpt-6.2-astra', usage)).toBeCloseTo(codexTokenCostUsd('gpt-6.2-astra', usage, 130_000)!, 10)
  })

  test('returns no cost for a model missing from the static catalog', () => {
    expect(codexTokenCostUsd('future-model', { inputTokens: 1_000 })).toBeUndefined()
  })
})
