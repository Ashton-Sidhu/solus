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
