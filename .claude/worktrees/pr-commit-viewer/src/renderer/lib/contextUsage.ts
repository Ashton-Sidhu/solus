import { MODEL_PROFILES } from '../../shared/types'
import type { AgentId, Session } from '../../shared/types'

const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * The effective window reported by the provider. Claude's `maxTokens` and
 * Codex's `modelContextWindow` already account for their reserved buffers, so
 * prefer those over the separately reported auto-compaction threshold. Falls
 * back to that threshold only when no effective window is available, then to
 * the selected model profile before the first turn reports anything.
 */
export function contextLimit(session: Session | null | undefined): number {
  if (!session) return DEFAULT_CONTEXT_WINDOW
  const usage = session.contextUsage
  if (usage?.windowTokens && usage.windowTokens > 0) return usage.windowTokens
  if (usage?.compactAtTokens && usage.compactAtTokens > 0) return usage.compactAtTokens
  if (session.run.modelConfig.contextWindow && session.run.modelConfig.contextWindow > 0) {
    return session.run.modelConfig.contextWindow
  }
  const provider = (session.run.provider ?? 'claude-code') as AgentId
  const model = session.sessionModel ?? session.run.modelConfig.modelId
  const profile = model ? MODEL_PROFILES[provider]?.[model] : undefined
  return profile?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
}

/** Tokens currently occupying the window. */
export function contextTokensUsed(session: Session | null | undefined): number {
  return session?.contextUsage?.usedTokens ?? 0
}

/** Fraction of the limit in use, clamped to [0, 1]. */
export function contextUsedFraction(used: number, limit: number): number {
  if (!limit || limit <= 0) return 0
  return Math.min(1, Math.max(0, used / limit))
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
