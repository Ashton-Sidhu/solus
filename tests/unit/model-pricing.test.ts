import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  modelPricing,
  modelTokenCostUsd,
  parseLiteLlmPrices,
  replaceModelPrices,
} from '@solus/server/execution/observability/model-pricing'
import { applyTaskCompleteAttrs } from '@solus/server/execution/observability/session-emitter-support'
import { MODEL_PRICES_MAX_AGE_MS, ModelPricesService } from '@solus/server/updates/model-prices-service'

// Entries in the shape of LiteLLM's `model_prices_and_context_window.json` (prices per token).
const LITELLM = JSON.stringify({
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'one of the providers' },
  'gpt-5.5': {
    input_cost_per_token: 5e-6, output_cost_per_token: 3e-5, cache_read_input_token_cost: 5e-7,
    input_cost_per_token_above_272k_tokens: 1e-5, output_cost_per_token_above_272k_tokens: 4.5e-5, cache_read_input_token_cost_above_272k_tokens: 1e-6,
    input_cost_per_token_priority: 1e-5, input_cost_per_token_flex: 2.5e-6,
  },
  'gpt-6.2-astra': { input_cost_per_token: 8e-6, output_cost_per_token: 4e-5, cache_read_input_token_cost: 4e-7, cache_creation_input_token_cost: 1e-5 },
  // A reseller's or a cloud's entry is never read: it can carry a markup.
  'azure/gpt-cheap': { input_cost_per_token: 1e-9, output_cost_per_token: 1e-9 },
  'vertex_ai/gemini-4-carbon': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
  'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7 },
  'no-output-rate': { input_cost_per_token: 1e-6 },
})

afterEach(() => replaceModelPrices(new Map()))

describe('Model prices from LiteLLM', () => {
  test("only the model makers' own prices are kept, and a model with no output rate has none", () => {
    const prices = parseLiteLlmPrices(LITELLM)
    expect([...prices.keys()].sort()).toEqual(['gemini/gemini-4-carbon', 'gpt-5.5', 'gpt-6.2-astra', 'sample_spec'])
    expect(parseLiteLlmPrices('not json').size).toBe(0)
  })

  test('a cache rate LiteLLM leaves out is the input rate, and a long-context tier keeps the standard ratios', () => {
    replaceModelPrices(parseLiteLlmPrices(LITELLM))
    expect(modelPricing('gpt-5.5')).toEqual({
      standard: { input: 5e-6, output: 3e-5, cachedInput: 5e-7, cacheWrite: 5e-6 },
      longContext: [{ thresholdTokens: 272_000, input: 1e-5, output: 4.5e-5, cachedInput: 1e-6, cacheWrite: 1e-5 }],
    })
  })

  test('prices uncached, cached, cache-write, and output tokens separately', () => {
    replaceModelPrices(parseLiteLlmPrices(LITELLM))
    expect(modelTokenCostUsd('gpt-6.2-astra', {
      inputTokens: 100_000,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 10_000,
      outputTokens: 20_000,
    })).toBeCloseTo((100_000 * 8 + 100_000 * 0.4 + 10_000 * 10 + 20_000 * 40) / 1_000_000, 10)
  })

  test('uses the long-context rate when a request passes the published input threshold', () => {
    replaceModelPrices(parseLiteLlmPrices(LITELLM))
    expect(modelTokenCostUsd('gpt-5.5', { inputTokens: 272_001, outputTokens: 10_000 }, 272_001)).toBeCloseTo(3.17001, 10)
  })

  test("a turn's many small requests are billed at the standard rate, however large their sum", () => {
    // WHY: a Codex turn sums every request it made. One turn read 22M cached
    // tokens in requests of ~130K; at the long-context rate its cost doubled.
    replaceModelPrices(parseLiteLlmPrices(LITELLM))
    const usage = { inputTokens: 300_000, cacheReadTokens: 20_000_000, outputTokens: 40_000 }
    expect(modelTokenCostUsd('gpt-5.5', usage, 130_000)).toBeCloseTo((300_000 * 5 + 20_000_000 * 0.5 + 40_000 * 30) / 1_000_000, 10)
    expect(modelTokenCostUsd('gpt-5.5', usage)).toBeCloseTo(modelTokenCostUsd('gpt-5.5', usage, 130_000)!, 10)
  })

  test("a Gemini model is priced at Google's own API rate", () => {
    replaceModelPrices(parseLiteLlmPrices(LITELLM))
    expect(modelTokenCostUsd('gemini-4-carbon', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(3, 10)
  })

  test('a model with no price, or a host with no list yet, records no cost instead of zero', () => {
    expect(modelTokenCostUsd('gpt-5.5', { inputTokens: 1_000 })).toBeUndefined()
    replaceModelPrices(parseLiteLlmPrices(LITELLM))
    expect(modelTokenCostUsd('future-model', { inputTokens: 1_000 })).toBeUndefined()
  })

  test("an Antigravity turn's cost comes from the price list; Claude's own reported cost stays", () => {
    replaceModelPrices(parseLiteLlmPrices(LITELLM))
    const event = { type: 'task_complete' as const, result: '', costUsd: 0, durationMs: 1, numTurns: 1, usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, sessionId: 's' }
    const antigravity: Record<string, number | string | boolean> = {}
    applyTaskCompleteAttrs(antigravity, { provider: 'antigravity', model: 'gemini-4-carbon' }, event)
    expect(antigravity).toMatchObject({ inputTokens: 1_000_000, outputTokens: 100_000, costUsd: 3 })
    const unpriced: Record<string, number | string | boolean> = {}
    applyTaskCompleteAttrs(unpriced, { provider: 'antigravity', model: 'gemini-9' }, event)
    expect(unpriced.costUsd).toBeUndefined()
    const claude: Record<string, number | string | boolean> = {}
    applyTaskCompleteAttrs(claude, { provider: 'claude-code', model: 'opus' }, { ...event, costUsd: 0.25 })
    expect(claude.costUsd).toBe(0.25)
  })
})

describe('Model price service', () => {
  function service(options: { now: number; download?: () => Promise<Map<string, never>> }) {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'solus-model-prices-')), 'model-prices.json')
    let downloads = 0
    const prices = new ModelPricesService({
      cachePath,
      now: () => options.now,
      download: async () => {
        downloads += 1
        return options.download ? options.download() : parseLiteLlmPrices(LITELLM)
      },
    })
    return { prices, cachePath, downloads: () => downloads }
  }

  test('a host downloads the list, keeps it on disk, and prices turns from it after a restart without a network', async () => {
    const first = service({ now: 1_000 })
    first.prices.start()
    await first.prices.check()
    first.prices.stop()
    expect(modelTokenCostUsd('gemini-4-carbon', { inputTokens: 1_000_000 })).toBeCloseTo(2, 10)

    replaceModelPrices(new Map())
    const offline = new ModelPricesService({ cachePath: first.cachePath, now: () => 2_000, download: () => Promise.reject(new Error('offline')) })
    offline.start()
    offline.stop()
    expect(modelTokenCostUsd('gemini-4-carbon', { inputTokens: 1_000_000 })).toBeCloseTo(2, 10)
  })

  test('a fresh list is not downloaded again; a day-old one is', () => {
    const fresh = service({ now: 5_000 })
    writeFileSync(fresh.cachePath, JSON.stringify({ fetchedAt: 4_000, prices: {} }))
    fresh.prices.start()
    fresh.prices.stop()
    expect(fresh.downloads()).toBe(0)

    const old = service({ now: 4_000 + MODEL_PRICES_MAX_AGE_MS })
    writeFileSync(old.cachePath, JSON.stringify({ fetchedAt: 4_000, prices: {} }))
    old.prices.start()
    old.prices.stop()
    expect(old.downloads()).toBe(1)
  })

  test('a failed download keeps the prices in effect and the file on disk', async () => {
    const failing = service({ now: 1_000, download: () => Promise.reject(new Error('HTTP 503')) })
    writeFileSync(failing.cachePath, JSON.stringify({ fetchedAt: 0, prices: Object.fromEntries(parseLiteLlmPrices(LITELLM)) }))
    failing.prices.start()
    await failing.prices.check()
    failing.prices.stop()
    expect(modelPricing('gpt-5.5')).not.toBeNull()
    expect(JSON.parse(readFileSync(failing.cachePath, 'utf8')).fetchedAt).toBe(0)
  })
})
