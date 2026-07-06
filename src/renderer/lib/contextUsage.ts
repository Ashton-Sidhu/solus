import { MODEL_PROFILES } from '../../shared/types'
import type { AgentId, Session, UsageData } from '../../shared/types'

const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Tokens currently occupying the context window: the prompt the model just saw.
 * That's fresh input plus everything read from / written to the prompt cache.
 * Output tokens are excluded — they aren't part of the current window (they roll
 * into the next turn's input, which the next usage report already reflects).
 */
export function contextTokensUsed(usage: UsageData | null | undefined): number {
  if (!usage) return 0
  return (usage.inputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheCreationTokens ?? 0)
}

/**
 * Total context window for a session. Prefer the runtime-reported limit when available,
 * then resolve per-tab from its selected model config/profile.
 */
export function resolveContextWindow(session: Session | null | undefined): number {
  if (!session) return DEFAULT_CONTEXT_WINDOW
  if (session.sessionUsage?.contextWindowTokens && session.sessionUsage.contextWindowTokens > 0) {
    return session.sessionUsage.contextWindowTokens
  }
  if (session.modelConfig.contextWindow && session.modelConfig.contextWindow > 0) {
    return session.modelConfig.contextWindow
  }
  const provider = (session.provider ?? 'claude-code') as AgentId
  const model = session.sessionModel ?? session.modelConfig.modelId
  const profile = model ? MODEL_PROFILES[provider]?.[model] : undefined
  return profile?.contextWindows?.[0] ?? DEFAULT_CONTEXT_WINDOW
}

/** Fraction of the context window in use, clamped to [0, 1]. */
export function contextFraction(used: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.min(1, Math.max(0, used / total))
}

/** Compact token count: 980, 60K, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`
  }
  const m = n / 1_000_000
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`
}
