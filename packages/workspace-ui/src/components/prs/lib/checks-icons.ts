/**
 * The checks glyphs, drawn with GitHub's own Octicons: a filled circle with a
 * check when they pass, a filled circle with a cross when they fail, and a
 * solid dot while they run. The git section and the PRs page read this one
 * set, so a state looks the same wherever it shows. The dot does not spin: a
 * long CI run must not repaint the panel for its whole duration.
 */
import { CircleAlert as CircleAlertIcon, CircleMinus as CircleMinusIcon } from '@lucide/svelte'
import type { CheckItem } from '@solus/contracts/checks-types'
import {
  CheckCircleFillIcon,
  DotFillIcon,
  SkipFillIcon,
  XCircleFillIcon,
} from '../../ui/octicons'
import { isFailing, type ChecksDisplayState } from './checks'

export type ChecksIcon = typeof CircleMinusIcon

export const CHECKS_ICON = {
  passing: CheckCircleFillIcon,
  failing: XCircleFillIcon,
  pending: DotFillIcon,
  unavailable: CircleAlertIcon,
  none: CircleMinusIcon,
} satisfies Record<ChecksDisplayState, ChecksIcon>

/** One check run's glyph, as GitHub's checks list draws it. */
export function checkItemIcon(item: CheckItem): ChecksIcon {
  if (item.inFlight) return DotFillIcon
  if (item.conclusion === 'skipped') return SkipFillIcon
  if (isFailing(item)) return XCircleFillIcon
  if (item.conclusion === 'success' || item.conclusion === 'neutral') return CheckCircleFillIcon
  return CircleMinusIcon
}
