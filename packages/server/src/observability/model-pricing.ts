import type { UsageData } from '@solus/contracts/types'

export interface TokenPricesUsdPerMillion {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
}

interface ModelTokenPricing {
  standard: TokenPricesUsdPerMillion
  longContext?: TokenPricesUsdPerMillion & { thresholdTokens: number }
}

/**
 * OpenAI list prices per million tokens for every Codex model Solus supports.
 * Keep this catalog beside the cost calculation so a model cannot silently
 * fall back to zero. Prices were checked against the official model pages on
 * 2026-08-17. Cache writes use the ordinary input rate unless OpenAI publishes
 * a separate rate; GPT-5.6 writes cost 1.25x input.
 */
export const CODEX_TOKEN_PRICING = {
  'gpt-5.6-sol': {
    standard: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
    longContext: { thresholdTokens: 272_000, input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 },
  },
  'gpt-5.6-terra': {
    standard: { input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15 },
    longContext: { thresholdTokens: 272_000, input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 22.5 },
  },
  'gpt-5.6-luna': {
    standard: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6 },
    longContext: { thresholdTokens: 272_000, input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 9 },
  },
  'gpt-5.5': {
    standard: { input: 5, cachedInput: 0.5, cacheWrite: 5, output: 30 },
    longContext: { thresholdTokens: 272_000, input: 10, cachedInput: 1, cacheWrite: 10, output: 45 },
  },
  'gpt-5.5-pro': {
    standard: { input: 30, cachedInput: 30, cacheWrite: 30, output: 180 },
    longContext: { thresholdTokens: 272_000, input: 60, cachedInput: 60, cacheWrite: 60, output: 270 },
  },
  'gpt-5.4': {
    standard: { input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, output: 15 },
    longContext: { thresholdTokens: 272_000, input: 5, cachedInput: 0.5, cacheWrite: 5, output: 22.5 },
  },
  'gpt-5.4-mini': {
    standard: { input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, output: 4.5 },
  },
  'gpt-5.3-codex': {
    standard: { input: 1.75, cachedInput: 0.175, cacheWrite: 1.75, output: 14 },
  },
} satisfies Record<string, ModelTokenPricing>

const codexTokenPricingByModel = new Map<string, ModelTokenPricing>(
  Object.entries(CODEX_TOKEN_PRICING),
)

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

/** Returns no value for an unknown model instead of recording a false zero. */
export function codexTokenCostUsd(model: string, usage: UsageData): number | undefined {
  const pricing = codexTokenPricingByModel.get(model)
  if (!pricing) return undefined

  const input = tokenCount(usage.inputTokens)
  const cachedInput = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheCreationTokens)
  const output = tokenCount(usage.outputTokens)
  if (input + cachedInput + cacheWrite + output === 0) return undefined
  const totalInput = input + cachedInput + cacheWrite
  const prices = pricing.longContext && totalInput > pricing.longContext.thresholdTokens
    ? pricing.longContext
    : pricing.standard

  return (
    input * prices.input
    + cachedInput * prices.cachedInput
    + cacheWrite * prices.cacheWrite
    + output * prices.output
  ) / 1_000_000
}
