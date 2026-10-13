// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestListRow.tsx (MIT, see UPSTREAM.md).
import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { SymbolView, type AppSymbolName } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { relativeTime } from '../../lib/time'
import { PullRequestAvatar, PullRequestDiffStats } from './detail/pull-request-ui'
import { PR_STATE_TINT_CLASS } from './components/PrStateBadge'
import { PR_STATE_LABELS, prStateTone } from './lib/pr-presentation'
import { pullRequestLabelColor, pullRequestRowReviewStatus, type PullRequestRow } from './lib/pull-request-list'

const STATE_ICON = {
  open: 'arrow.triangle.pull',
  draft: 'arrow.triangle.pull',
  merged: 'arrow.triangle.merge',
  closed: 'xmark.circle.fill',
} as const satisfies Record<keyof typeof PR_STATE_LABELS, AppSymbolName>

const REVIEW_ICON = {
  danger: { icon: 'exclamationmark.circle', tint: 'accent-danger-foreground' },
  success: { icon: 'checkmark.circle', tint: 'accent-adaptive-emerald-600-400' },
  warning: { icon: 'eye', tint: 'accent-warning-foreground' },
  muted: { icon: 'person.2', tint: 'accent-icon-muted' },
} as const

const CHECKS = {
  passing: { icon: 'checkmark.circle', tint: 'accent-adaptive-emerald-600-400' },
  failing: { icon: 'xmark.circle.fill', tint: 'accent-danger-foreground' },
  pending: { icon: 'clock', tint: 'accent-warning-foreground' },
} as const

/**
 * One pull request of the Pull Requests tab: its state mark, the author's
 * avatar, the project and number, the title, then labels, checks, review,
 * and size. `hostLabel` names the host when the list shows more than one.
 */
export const PullRequestListRow = memo(function PullRequestListRow(props: {
  readonly row: PullRequestRow
  readonly hostLabel: string | null
  readonly onSelect: (row: PullRequestRow) => void
}) {
  const { row, hostLabel } = props
  const { pr } = row
  const tone = prStateTone(pr)
  const review = pullRequestRowReviewStatus(pr)
  const checks = row.checks && row.checks !== 'none' ? row.checks : null
  const place = hostLabel ? `${row.folderName} · ${hostLabel}` : row.folderName
  const label = [
    `Pull request ${pr.number}, ${pr.title}, ${PR_STATE_LABELS[tone]}, by ${pr.author}, ${place}`,
    review?.accessibleLabel,
    checks ? `checks ${checks}` : null,
    pr.stack ? `stack ${pr.stack.position} of ${pr.stack.size}` : null,
    pr.labels.length ? pr.labels.map((entry) => entry.name).join(', ') : null,
    `${pr.additions} additions, ${pr.deletions} deletions`,
  ].filter(Boolean).join(', ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the pull request"
      onPress={() => props.onSelect(row)}
      className="flex-row gap-3 px-4 active:bg-row-hover"
    >
      <View className="pt-2.5">
        <SymbolView name={STATE_ICON[tone]} size={20} tintColorClassName={PR_STATE_TINT_CLASS[tone]} />
      </View>
      <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
        <View className="flex-row items-center gap-1.5">
          <PullRequestAvatar login={pr.author} avatarUrl={pr.authorAvatarUrl} size={16} />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {place} <Text className="text-foreground-tertiary">#{pr.number}</Text>
          </Text>
          {pr.stack ? (
            <View className="flex-row items-center gap-1">
              <SymbolView name="square.3.layers.3d" size={12} tintColorClassName="accent-icon-muted" />
              <Text className="text-2xs tabular-nums text-foreground-muted">{pr.stack.position}/{pr.stack.size}</Text>
            </View>
          ) : null}
          <Text className="text-2xs tabular-nums text-foreground-tertiary">{relativeTime(pr.updatedAt)}</Text>
        </View>
        <Text className="text-base leading-5 font-t3-medium text-foreground" numberOfLines={2} ellipsizeMode="tail">
          {pr.title}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <View className="min-w-0 flex-1 flex-row items-center gap-1">
            {pr.labels.slice(0, 2).map((entry) => {
              const color = pullRequestLabelColor(entry.color)
              return (
                <View
                  key={entry.name}
                  className="min-w-0 shrink flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5"
                  style={color ? { maxWidth: 160, backgroundColor: `${color}20` } : { maxWidth: 160 }}
                >
                  {color ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} /> : null}
                  <Text className="shrink text-2xs font-t3-medium text-foreground-muted" numberOfLines={1}>{entry.name}</Text>
                </View>
              )
            })}
            {pr.labels.length > 2 ? <Text className="shrink-0 text-2xs text-foreground-tertiary">+{pr.labels.length - 2}</Text> : null}
          </View>
          {checks ? <SymbolView name={CHECKS[checks].icon} size={13} tintColorClassName={CHECKS[checks].tint} /> : null}
          {review ? <SymbolView name={REVIEW_ICON[review.tone].icon} size={13} tintColorClassName={REVIEW_ICON[review.tone].tint} /> : null}
          {pr.additions || pr.deletions ? <PullRequestDiffStats additions={pr.additions} deletions={pr.deletions} compact /> : null}
        </View>
      </View>
    </Pressable>
  )
},
// Rows are rebuilt on every directory change; the pull request objects are kept until a read replaces them.
(previous, next) =>
  previous.row.pr === next.row.pr
  && previous.row.checks === next.row.checks
  && previous.row.folderName === next.row.folderName
  && previous.hostLabel === next.hostLabel
  && previous.onSelect === next.onSelect)
