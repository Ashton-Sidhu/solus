import type { AgentUsageLimits, UsageWindow } from '../../../shared/types'

/** The two windows the `/usage` report exposes, before they're wrapped in a
 *  provider envelope. */
export type ClaudeUsageWindows = Pick<AgentUsageLimits, 'fiveHour' | 'weekly'>

// Anchored on the line prefixes, not line position: the report also carries
// per-model week lines ("Current week (Fable)") and a usage breakdown whose
// length varies with how much the account has run.
// The session's reset clause is optional: before the first request of a
// 5-hour block there is no window to reset, so Claude prints the percent
// alone. Requiring the clause dropped the whole meter at the start of every
// block — a window at 0% is a fact worth showing, countdown or not.
const SESSION_LINE = /^Current session: (\d+)% used(?: · resets (.+))?$/m
const WEEKLY_LINE = /^Current week \(all models\): (\d+)% used · resets (.+)$/m

/**
 * Reads the quota windows out of the plain-text report `/usage` prints. Claude
 * Code exposes no JSON usage API (anthropics/claude-code#13585), so text is all
 * there is. Returns null when neither window matches, so a wording change
 * degrades to "unknown" instead of a fabricated number.
 */
export function parseClaudeUsageReport(report: string): ClaudeUsageWindows | null {
  const fiveHour = usageWindow(report.match(SESSION_LINE))
  const weekly = usageWindow(report.match(WEEKLY_LINE))
  if (!fiveHour && !weekly) return null
  return { fiveHour, weekly }
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
