import type { CheckItem } from '@solus/contracts/checks-types'
import { checkResultLabel, isFailing } from '../../prs/lib/checks'

/**
 * How one check reads in the review rail: a compact visual state and the word
 * exposed to assistive technology.
 *
 * The rail states a verdict rather than drawing a status dot beside a name. A
 * The compact leading icon carries the familiar result signal. Its word stays
 * in the accessibility tree instead of repeating the same state at the far
 * edge of a narrow row.
 *
 * `checkResultLabel` is the *chip's* vocabulary — sentence case, and "No result"
 * for a check the host has not concluded. In the rail an unconcluded check that
 * is not in flight is not resultless, it is waiting, so it says so.
 */
export interface CheckVerdict {
  word: string
  icon: 'passed' | 'failed' | 'running' | 'pending'
}

/**
 * The one line a folded Checks section shows: what is
 * broken leads, then what is still running, then the all-clear. A queued check
 * counts as running — it has not answered yet either way. The icon is the
 * row vocabulary's, so the summary and the rows under it read as one state.
 */
export function checksSummary(checks: CheckItem[]): {
  text: string
  icon: 'passed' | 'failed' | 'running'
} {
  let failed = 0
  let running = 0
  for (const check of checks) {
    const icon = checkVerdict(check).icon
    if (icon === 'failed') failed++
    else if (icon === 'running' || icon === 'pending') running++
  }
  if (failed > 0) return { text: `${failed} of ${checks.length} failing`, icon: 'failed' }
  if (running > 0) return { text: `${running} of ${checks.length} running`, icon: 'running' }
  return { text: 'All checks passed', icon: 'passed' }
}

export function checkVerdict(item: CheckItem): CheckVerdict {
  if (item.inFlight) {
    return {
      word: 'running',
      icon: 'running',
    }
  }
  if (!item.conclusion) {
    return {
      word: 'queued',
      icon: 'pending',
    }
  }
  const hasFailed = isFailing(item)
  return {
    word: checkResultLabel(item).toLowerCase(),
    icon: hasFailed ? 'failed' : 'passed',
  }
}
