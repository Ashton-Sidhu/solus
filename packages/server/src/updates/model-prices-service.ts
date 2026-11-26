import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { modelTokenPricingSchema, parseLiteLlmPrices, replaceModelPrices, type ModelTokenPricing } from '../execution/observability/model-pricing'

const log = createLogger('model-prices', 'model-prices-service.ts')

/** LiteLLM's price list, which T3 Code reads too. About 5 MB; the host keeps only the first-party prices. */
export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
/** The host downloads the list again once it is this old. */
export const MODEL_PRICES_MAX_AGE_MS = 24 * 60 * 60_000
/** A host that sleeps checks within this long of waking; a failed download tries again then. */
const CHECK_INTERVAL_MS = 60 * 60_000

export async function downloadLiteLlmPrices(): Promise<Map<string, ModelTokenPricing>> {
  const response = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for the model price list.`)
  const prices = parseLiteLlmPrices(await response.text())
  if (prices.size === 0) throw new Error('The model price list has no prices Solus can read.')
  return prices
}

const cachedPricesSchema = z.object({ fetchedAt: z.number(), prices: z.record(z.string(), modelTokenPricingSchema) })

interface ModelPricesServiceDeps {
  /** Where the last list is kept, so a restart without a network still prices turns. */
  cachePath: string
  download(): Promise<Map<string, ModelTokenPricing>>
  now?: () => number
}

/**
 * The prices Insights gives a turn's tokens. Until the host reads its cached
 * list or downloads one, a turn's cost is unknown, never zero.
 */
export class ModelPricesService {
  private fetchedAt: number | null = null
  private readonly now: () => number
  private pending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly deps: ModelPricesServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Synchronous up to the network: the cached prices are in effect before the host serves a turn. */
  start(): void {
    this.stopped = false
    const cached = this.readCache()
    if (cached) {
      replaceModelPrices(new Map(Object.entries(cached.prices)))
      this.fetchedAt = cached.fetchedAt
    }
    this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Downloads the list now. A failed download keeps the prices in effect. */
  check(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      try {
        const prices = await this.deps.download()
        this.fetchedAt = this.now()
        replaceModelPrices(prices)
        mkdirSync(dirname(this.deps.cachePath), { recursive: true })
        writeFileSync(this.deps.cachePath, JSON.stringify({ fetchedAt: this.fetchedAt, prices: Object.fromEntries(prices) }))
        log.info('model_prices_updated', { models: prices.size })
      } catch (error) {
        log.warn('model_prices_check_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    })().finally(() => { this.pending = null })
    return this.pending
  }

  private tick(): void {
    if (this.stopped) return
    if (this.fetchedAt === null || this.now() - this.fetchedAt >= MODEL_PRICES_MAX_AGE_MS) void this.check()
    this.timer = setTimeout(() => this.tick(), CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  private readCache(): z.infer<typeof cachedPricesSchema> | null {
    let raw: string
    try { raw = readFileSync(this.deps.cachePath, 'utf8') } catch { return null }
    try {
      const cached = cachedPricesSchema.safeParse(JSON.parse(raw))
      if (cached.success) return cached.data
    } catch {}
    log.warn('model_prices_cache_ignored', { cachePath: this.deps.cachePath })
    return null
  }
}
