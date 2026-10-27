// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestControls.tsx, PullRequestPresentation.tsx, PullRequestSectionHeading.tsx, and pullRequestStatus.ts (MIT, see UPSTREAM.md).
import { Image } from 'expo-image'
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import type { PullRequest } from '@solus/contracts/providers'
import { SymbolView, type AppSymbolName } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { EmptyState } from '../../../components/EmptyState'
import { cn } from '../../../lib/cn'
import { prStateTone, type PrStateTone } from '../lib/pr-presentation'

/**
 * The pieces every part of the pull request detail draws with: T3's grouped
 * card and its rows, the section heading, the diff counts, an avatar, and the
 * state of a pull request in a word, a symbol, and a color.
 */

export const PR_STATUS = {
  open: { label: 'Open', icon: 'arrow.triangle.pull', tint: 'accent-adaptive-emerald-600-400', text: 'text-adaptive-emerald-600-400' },
  merged: { label: 'Merged', icon: 'arrow.triangle.merge', tint: 'accent-adaptive-violet-600-400', text: 'text-adaptive-violet-600-400' },
  closed: { label: 'Closed', icon: 'arrow.triangle.pull', tint: 'accent-danger-foreground', text: 'text-danger-foreground' },
  draft: { label: 'Draft', icon: 'pencil', tint: 'accent-icon-muted', text: 'text-foreground-muted' },
} as const satisfies Record<PrStateTone, { label: string; icon: AppSymbolName; tint: string; text: string }>

export function pullRequestStatus(pr: Pick<PullRequest, 'state' | 'draft'>) {
  return PR_STATUS[prStateTone(pr)]
}

export function PullRequestCardGroup(props: { readonly children: ReactNode }) {
  return <View className="overflow-hidden rounded-[22px] border border-pr-card-border border-continuous bg-pr-card">{props.children}</View>
}

export function PullRequestCardRow(props: {
  readonly title: string
  readonly icon: AppSymbolName
  readonly tint?: string
  readonly value?: string
  readonly detail?: string
  readonly onPress?: () => void
  readonly accessibilityLabel?: string
  readonly destructive?: boolean
  readonly last?: boolean
  readonly compact?: boolean
  /** A row that opens a menu: its parent menu answers the press. */
  readonly menu?: boolean
  readonly expanded?: boolean
  readonly busy?: boolean
  readonly children?: ReactNode
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress || props.menu ? 'button' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={props.expanded === undefined ? { busy: props.busy } : { expanded: props.expanded, busy: props.busy }}
      onPress={props.onPress}
      disabled={!props.onPress && !props.menu}
      className={cn(
        props.compact ? 'min-h-11 py-2.5' : 'min-h-13 py-3',
        'flex-row items-center gap-3 px-4',
        !props.last && !props.compact && 'border-b border-border-subtle',
        props.onPress && 'active:opacity-70',
      )}
    >
      <CardRowIcon icon={props.icon} tint={props.tint} destructive={props.destructive} busy={props.busy} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className={props.destructive ? 'text-sm font-t3-medium text-danger-foreground' : 'text-sm font-t3-medium'}>{props.title}</Text>
        {props.detail ? <Text className="text-2xs text-foreground-muted" numberOfLines={2}>{props.detail}</Text> : null}
      </View>
      {props.children ?? (props.value ? (
        <Text className={cn(props.compact ? 'max-w-[38%] text-2xs' : 'max-w-[60%] text-xs', 'shrink text-right text-foreground-muted')} numberOfLines={2}>
          {props.value}
        </Text>
      ) : null)}
      {props.onPress || props.menu ? <CardRowChevron expanded={props.expanded} /> : null}
    </Pressable>
  )
}

/** The leading symbol of a card row, or a spinner while the row is busy. */
function CardRowIcon(props: { readonly icon: AppSymbolName; readonly tint?: string; readonly destructive?: boolean; readonly busy?: boolean }) {
  if (props.busy) return <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
  return <SymbolView name={props.icon} size={18} tintColorClassName={props.destructive ? 'accent-danger-foreground' : (props.tint ?? 'accent-icon-muted')} />
}

/** The trailing chevron of a row that can be pressed: it points down or up when the row expands. */
function CardRowChevron({ expanded }: { readonly expanded?: boolean }) {
  return (
    <SymbolView
      name={expanded === undefined ? 'chevron.right' : expanded ? 'chevron.up' : 'chevron.down'}
      size={11}
      tintColorClassName="accent-icon-muted"
    />
  )
}

export function PullRequestSectionHeading({ children }: { readonly children: ReactNode }) {
  return <Text accessibilityRole="header" className="text-base font-t3-semibold">{children}</Text>
}

export function PullRequestDiffStats(props: { readonly additions: number; readonly deletions: number; readonly compact?: boolean }) {
  const textSize = props.compact ? 'text-2xs' : 'text-xs'
  return (
    <View className="shrink-0 flex-row items-center gap-2">
      {!props.compact || props.additions > 0 ? (
        <Text className={cn(textSize, 'font-t3-medium tabular-nums text-diff-added')}>+{props.additions.toLocaleString()}</Text>
      ) : null}
      {!props.compact || props.deletions > 0 ? (
        <Text className={cn(textSize, 'font-t3-medium tabular-nums text-diff-removed')}>−{props.deletions.toLocaleString()}</Text>
      ) : null}
    </View>
  )
}

/** A GitHub avatar, or the login's first letter when the host sent no image. */
export function PullRequestAvatar(props: { readonly login: string | null; readonly avatarUrl?: string | null; readonly size?: number }) {
  const size = props.size ?? 24
  return props.avatarUrl ? (
    <Image
      source={{ uri: props.avatarUrl }}
      recyclingKey={props.avatarUrl}
      accessibilityLabel={props.login ?? undefined}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      cachePolicy="memory-disk"
    />
  ) : (
    <View className="items-center justify-center rounded-full bg-subtle" style={{ width: size, height: size }}>
      <Text className="font-t3-medium text-foreground-muted" style={{ fontSize: size * 0.45 }}>{props.login?.slice(0, 1).toUpperCase() ?? '?'}</Text>
    </View>
  )
}

/** A spinner while there is nothing to show, or why the read failed. */
export function PullRequestReadStatus(props: { readonly pending: boolean; readonly error: string | null; readonly onRetry?: () => void }) {
  if (props.pending) return <ActivityIndicator className="my-12" colorClassName="accent-icon" />
  if (!props.error) return null
  return <EmptyState title="Could not load this pull request" detail={props.error} variant="plain" {...(props.onRetry ? { actionLabel: 'Try again', onAction: props.onRetry } : {})} />
}

/** A short line that says why a control is off. */
export function DisabledReason({ children }: { readonly children: string | null }) {
  return children ? <Text className="px-1 text-xs text-foreground-muted">{children}</Text> : null
}
