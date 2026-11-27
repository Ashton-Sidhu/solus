import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AgentUsageLimits, UsageWindow } from '@solus/contracts/types'

/** The windows the `/usage` report exposes, before they're wrapped in a
 *  provider envelope. */
export type ClaudeUsageWindows = Pick<AgentUsageLimits, 'fiveHour' | 'weekly' | 'fableWeekly'>

/** The windows plus the plan tier and spend cap, which only the structured usage API names. */
export type ClaudeUsageReport = Pick<AgentUsageLimits, 'fiveHour' | 'weekly' | 'fableWeekly' | 'monthly' | 'planType'>

type ApiUsageWindow = { utilization: number | null; resets_at: string | null } | null | undefined
type ApiRateLimits = NonNullable<SDKControlGetUsageResponse['rate_limits']>
type ApiExtraUsage = ApiRateLimits['extra_usage']

/**
 * Maps the SDK's structured usage answer. `utilization` is already a percent
 * (0-100), and `resets_at` is ISO 8601. Returns null when plan limits do not
 * apply (API key, Bedrock, Vertex) or the answer carries no window, so the
 * meter reads "unknown" rather than 0%. Of the per-model weekly windows, only
 * Fable's is kept (`fableWeekly`).
 *
 * An Enterprise seat has no 5h or weekly window. Its limit is a monthly spend
 * cap, which the answer carries as `extra_usage`. On a seat with windows,
 * `extra_usage` is overage on top of them, not the limit, so it is read only
 * when no window is reported.
 */
export function claudeUsageFromApi(response: SDKControlGetUsageResponse): ClaudeUsageReport | null {
  if (!response.rate_limits_available || !response.rate_limits) return null
  const fiveHour = apiUsageWindow(response.rate_limits.five_hour)
  const weekly = apiUsageWindow(response.rate_limits.seven_day)
  const planType = response.subscription_type ?? null
  if (fiveHour || weekly) return { fiveHour, weekly, fableWeekly: fableWindow(response.rate_limits.model_scoped), planType }
  const monthly = spendCapWindow(response.rate_limits.extra_usage)
  return monthly && { fiveHour: null, weekly: null, monthly, planType }
}

/** A cap exists only when the answer names a limit; without one there is nothing to meter. */
function spendCapWindow(extraUsage: ApiExtraUsage): UsageWindow | null {
  const limit = extraUsage?.monthly_limit
  if (!extraUsage || typeof limit !== 'number' || limit <= 0) return null
  const { utilization, used_credits: used } = extraUsage
  const usedPercent = typeof utilization === 'number' ? utilization : typeof used === 'number' ? (used / limit) * 100 : null
  return usedPercent === null ? null : { usedPercent, resetsAt: null, resetsLabel: null }
}

/** The server names each per-model bucket with a display label ('Fable'); it
 *  gives no stable id, so the label is the match. */
function fableWindow(modelScoped: ApiRateLimits['model_scoped']): UsageWindow | null {
  const bucket = modelScoped?.find((entry) => entry.display_name.trim().toLowerCase() === 'fable')
  return apiUsageWindow(bucket)
}

function apiUsageWindow(window: ApiUsageWindow): UsageWindow | null {
  if (!window || typeof window.utilization !== 'number') return null
  const resetsAt = window.resets_at ? Date.parse(window.resets_at) : NaN
  return {
    usedPercent: window.utilization,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetsLabel: null,
  }
}

// Anchored on the line prefixes, not line position: the report also carries
// per-model week lines ("Current week (Fable)") and a usage breakdown whose
// length varies with how much the account has run.
// The session's reset clause is optional: before the first request of a
// 5-hour block there is no window to reset, so Claude prints the percent
// alone. Requiring the clause dropped the whole meter at the start of every
// block — a window at 0% is a fact worth showing, countdown or not.
const SESSION_LINE = /^Current session: (\d+)% used(?: · resets (.+))?$/m
const WEEKLY_LINE = /^Current week \(all models\): (\d+)% used · resets (.+)$/m
const FABLE_WEEKLY_LINE = /^Current week \(Fable\): (\d+)% used(?: · resets (.+))?$/m

/**
 * Reads the quota windows out of the plain-text report `/usage` prints. Claude
 * Code exposes no JSON usage API (anthropics/claude-code#13585), so text is all
 * there is. Returns null when neither provider-wide window matches, so a
 * wording change degrades to "unknown" instead of a fabricated number.
 */
export function parseClaudeUsageReport(report: string): ClaudeUsageWindows | null {
  const fiveHour = usageWindow(report.match(SESSION_LINE))
  const weekly = usageWindow(report.match(WEEKLY_LINE))
  if (!fiveHour && !weekly) return null
  return { fiveHour, weekly, fableWeekly: usageWindow(report.match(FABLE_WEEKLY_LINE)) }
}

function usageWindow(match: RegExpMatchArray | null): UsageWindow | null {
  if (!match) return null
  return {
    usedPercent: Number(match[1]),
    // The reset text is localized and carries no year ("Aug 6 at 4:59pm
    // (America/Toronto)") — nothing safe to turn into an epoch, so the
    // provider's own wording is all we keep.
    resetsAt: null,
    resetsLabel: match[2]?.trim() ?? null,
  }
}
