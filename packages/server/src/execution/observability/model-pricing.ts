import { z } from 'zod'
import type { UsageData } from '@solus/contracts/types'

/** Token prices in USD per token. */
export interface TokenPrices {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
}

const tokenPricesSchema = z.object({ input: z.number(), cachedInput: z.number(), cacheWrite: z.number(), output: z.number() })

/** A model's prices: the standard rate, and the rates of a request whose input passes a threshold, largest threshold first. */
export const modelTokenPricingSchema = z.object({
  standard: tokenPricesSchema,
  longContext: z.array(tokenPricesSchema.extend({ thresholdTokens: z.number() })),
})
export type ModelTokenPricing = z.infer<typeof modelTokenPricingSchema>

/**
 * The model makers' own APIs in LiteLLM's names. A bare name is the maker's
 * own too. A cloud's or a reseller's price (`azure/`, `vertex_ai/`, …) is never
 * read: it can carry a markup.
 */
const FIRST_PARTY_PREFIXES = ['openai/', 'gemini/', 'anthropic/'] as const

const liteLlmDocumentSchema = z.string().transform((text, context) => {
  try {
    return z.record(z.string(), z.json()).parse(JSON.parse(text))
  } catch {
    context.addIssue({ code: 'custom', message: 'The price list is not a JSON object.' })
    return z.NEVER
  }
})
const priceSchema = z.number().finite().nonnegative()
const priceFieldsSchema = z.record(z.string(), z.json()).transform((entry) => {
  const fields = new Map<string, number>()
  for (const [name, value] of Object.entries(entry)) {
    const price = priceSchema.safeParse(value)
    if (price.success) fields.set(name, price.data)
  }
  return fields
})
const LONG_CONTEXT_INPUT = /^input_cost_per_token_above_(\d{1,7})k_tokens$/

/** A rate LiteLLM leaves out is the input rate, scaled as the standard rates are when there are some. */
function pricesOf(fields: Map<string, number>, suffix: string, standard?: TokenPrices): TokenPrices | null {
  const input = fields.get(`input_cost_per_token${suffix}`)
  const output = fields.get(`output_cost_per_token${suffix}`) ?? standard?.output
  if (input === undefined || output === undefined) return null
  const scaled = (rate: keyof TokenPrices) => standard && standard.input > 0 ? standard[rate] / standard.input * input : input
  return {
    input,
    output,
    cachedInput: fields.get(`cache_read_input_token_cost${suffix}`) ?? scaled('cachedInput'),
    cacheWrite: fields.get(`cache_creation_input_token_cost${suffix}`) ?? scaled('cacheWrite'),
  }
}

function pricingOf(fields: Map<string, number>): ModelTokenPricing | null {
  const standard = pricesOf(fields, '')
  if (!standard) return null
  const longContext: ModelTokenPricing['longContext'] = []
  for (const name of fields.keys()) {
    const threshold = LONG_CONTEXT_INPUT.exec(name)?.[1]
    const prices = threshold ? pricesOf(fields, `_above_${threshold}k_tokens`, standard) : null
    if (prices) longContext.push({ ...prices, thresholdTokens: Number(threshold) * 1_000 })
  }
  longContext.sort((a, b) => b.thresholdTokens - a.thresholdTokens)
  return { standard, longContext }
}

/**
 * The first-party prices in LiteLLM's `model_prices_and_context_window.json`,
 * by lower-case name. A model with no input or output rate is left out, so its
 * cost reads as unknown, not as zero.
 */
export function parseLiteLlmPrices(text: string): Map<string, ModelTokenPricing> {
  const prices = new Map<string, ModelTokenPricing>()
  const entries = liteLlmDocumentSchema.safeParse(text)
  if (!entries.success) return prices
  for (const [name, entry] of Object.entries(entries.data)) {
    const key = name.trim().toLowerCase()
    if (key.includes('/') && !FIRST_PARTY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    const fields = priceFieldsSchema.safeParse(entry)
    const pricing = fields.success ? pricingOf(fields.data) : null
    if (pricing) prices.set(key, pricing)
  }
  return prices
}

/** The prices in effect: empty until the host has read its cached list or downloaded one (`updates/model-prices-service.ts`). */
let modelPrices: ReadonlyMap<string, ModelTokenPricing> = new Map()

export function replaceModelPrices(prices: ReadonlyMap<string, ModelTokenPricing>): void {
  modelPrices = prices
}

/** A model's prices: its own name first, then the maker's API names. */
export function modelPricing(model: string): ModelTokenPricing | null {
  const key = model.trim().toLowerCase()
  if (!key) return null
  for (const candidate of [key, ...FIRST_PARTY_PREFIXES.map((prefix) => `${prefix}${key}`)]) {
    const pricing = modelPrices.get(candidate)
    if (pricing) return pricing
  }
  return null
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * What a turn's tokens cost. Returns no value for a model with no price instead
 * of recording a false zero. The long-context rate is per request: a turn sums
 * many requests, so its token totals pass the threshold when no request did.
 * `requestInputTokens` is the largest request's input, which the context fill
 * at the end of the turn stands for; unknown, the turn is billed at the
 * standard rate.
 */
export function modelTokenCostUsd(model: string, usage: UsageData, requestInputTokens?: number): number | undefined {
  const pricing = modelPricing(model)
  if (!pricing) return undefined
  const input = tokenCount(usage.inputTokens)
  const cachedInput = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheCreationTokens)
  const output = tokenCount(usage.outputTokens)
  if (input + cachedInput + cacheWrite + output === 0) return undefined
  const prices = (requestInputTokens !== undefined && pricing.longContext.find((tier) => requestInputTokens > tier.thresholdTokens)) || pricing.standard
  return input * prices.input + cachedInput * prices.cachedInput + cacheWrite * prices.cacheWrite + output * prices.output
}
