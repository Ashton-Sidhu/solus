// Adapted from T3 Code apps/mobile/src/features/threads/thread-list-v2-items.tsx and state/thread-pr-presentation.ts (MIT, see UPSTREAM.md).
import { View } from 'react-native'
import type { PullRequest } from '@solus/contracts/providers'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { cn } from '../../../lib/cn'
import { CODE_FONT } from '../../../theme/tokens'
import { PR_STATE_LABELS, prStateTone, type PrStateTone } from '../lib/pr-presentation'

/** T3 Code's pull request colors: open emerald, merged violet, closed rose, a
 *  draft muted, because it is not asking to land yet. */
const PR_STATE_TEXT_CLASS = {
  open: 'text-adaptive-emerald-600-400',
  merged: 'text-adaptive-violet-600-400',
  closed: 'text-adaptive-rose-600-400',
  draft: 'text-foreground-muted',
} as const satisfies Record<PrStateTone, string>

export const PR_STATE_TINT_CLASS = {
  open: 'accent-adaptive-emerald-600-400',
  merged: 'accent-adaptive-violet-600-400',
  closed: 'accent-adaptive-rose-600-400',
  draft: 'accent-icon-muted',
} as const satisfies Record<PrStateTone, string>

/** The pull request mark, "Open", and "#123", in the state's color. */
export function PrStateBadge({ pr, showLabel = true }: { pr: Pick<PullRequest, 'state' | 'draft' | 'number'>; showLabel?: boolean }) {
  const tone = prStateTone(pr)
  return (
    <View
      accessible
      accessibilityLabel={`#${pr.number} pull request ${PR_STATE_LABELS[tone].toLowerCase()}`}
      className="flex-row items-center gap-1"
    >
      <SymbolView name="arrow.triangle.pull" size={12} tintColorClassName={PR_STATE_TINT_CLASS[tone]} />
      {showLabel ? <Text className={cn('text-xs font-t3-medium', PR_STATE_TEXT_CLASS[tone])}>{PR_STATE_LABELS[tone]}</Text> : null}
      <Text className={cn('text-xs', PR_STATE_TEXT_CLASS[tone])} style={{ fontFamily: CODE_FONT }}>
        {pr.number}
      </Text>
    </View>
  )
}
