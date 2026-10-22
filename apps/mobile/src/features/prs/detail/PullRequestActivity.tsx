// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestTimeline.tsx, PullRequestActivityFilters.tsx, and PullRequestEntryRow.tsx (MIT, see UPSTREAM.md).
import { useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import type { PrCommentActivityItem, PrCommit, PrConversationItem, ReviewThread } from '@solus/contracts/providers'
import { groupThreadsByReview, reviewIsEvent } from '@solus/client-core/review-groups'
import { SymbolView, type AppSymbolName } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { ControlPillMenu } from '../../../components/ControlPillMenu'
import { CODE_FONT } from '../../../theme/tokens'
import { prAge } from '../lib/pr-presentation'
import type { ActivityFilter, PullRequestActivity } from '../lib/pull-request-activity'
import { pullRequestLabelColor } from '../lib/pull-request-list'
import { PullRequestMarkdown } from './PullRequestMarkdown'
import { PullRequestAvatar } from './pull-request-ui'

export interface ActivityRow {
  readonly key: string
  readonly date: string
  readonly content: ReactNode
}

function TimelineEvent(props: { readonly icon: AppSymbolName; readonly tone?: 'success' | 'danger'; readonly children: ReactNode }) {
  return (
    <View className="flex-row gap-3">
      <View className="relative w-8 items-center">
        <View className="absolute top-0 bottom-0 w-px bg-border-subtle" />
        <View className="size-8 items-center justify-center rounded-full border border-border-subtle bg-grouped-card">
          <SymbolView
            name={props.icon}
            size={15}
            tintColorClassName={props.tone === 'success' ? 'accent-adaptive-emerald-600-400' : props.tone === 'danger' ? 'accent-danger-foreground' : 'accent-icon-muted'}
          />
        </View>
      </View>
      <View className="min-w-0 flex-1 gap-2 pt-1 pb-6">{props.children}</View>
    </View>
  )
}

function EventHeader(props: { readonly author: string; readonly avatarUrl?: string; readonly verb: string; readonly at: string; readonly now: number }) {
  return (
    <View className="flex-row items-center gap-2">
      <PullRequestAvatar login={props.author} avatarUrl={props.avatarUrl ?? null} size={22} />
      <Text className="min-w-0 flex-1 text-sm" numberOfLines={2}>
        <Text className="font-t3-medium">{props.author}</Text>
        <Text className="text-foreground-muted">{` ${props.verb}`}</Text>
      </Text>
      <Text className="text-2xs text-foreground-tertiary">{prAge(props.at, props.now)}</Text>
    </View>
  )
}

/** One inline thread: where it is, its first words, and its state. Opens the discussion. */
function ThreadCard({ thread, onOpen }: { readonly thread: ReviewThread; readonly onOpen: (threadId: string) => void }) {
  const first = thread.comments[0]
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${thread.isResolved ? 'resolved' : 'unresolved'} discussion in ${thread.filePath}`}
      onPress={() => onOpen(thread.id)}
      className="gap-2 rounded-2xl bg-grouped-card p-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView name="doc.text" size={14} tintColorClassName="accent-icon-muted" />
        <Text className="flex-1 text-xs" style={{ fontFamily: CODE_FONT }} numberOfLines={2}>{thread.filePath}{thread.line ? `:${thread.line}` : ''}</Text>
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
      </View>
      {first?.body ? <Text className="text-sm" numberOfLines={3}>{first.body}</Text> : null}
      <Text className="text-xs text-foreground-muted">
        {thread.isResolved ? 'Resolved' : 'Unresolved'}{thread.isOutdated ? ' · Outdated' : ''} · {thread.comments.length} {thread.comments.length === 1 ? 'comment' : 'comments'}
      </Text>
    </Pressable>
  )
}

/** What the author did, as the host words it. */
function commentVerb(item: PrCommentActivityItem, threadCount: number): string {
  if (item.reviewState === 'APPROVED') return 'approved'
  if (item.reviewState === 'CHANGES_REQUESTED') return 'requested changes'
  if (item.reviewState === 'DISMISSED') return 'had a review dismissed'
  if (item.kind !== 'review') return 'commented'
  if (threadCount === 0) return 'reviewed'
  return `reviewed · ${threadCount} ${threadCount === 1 ? 'thread' : 'threads'}`
}

/** A long comment is cut until the person opens it. A review carries the
 *  inline threads it was submitted with, nested under its body as the host
 *  shows them. */
function TimelineComment({ item, threads, now, onOpenThread }: {
  readonly item: PrCommentActivityItem
  readonly threads: readonly ReviewThread[]
  readonly now: number
  readonly onOpenThread: (threadId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const approved = item.reviewState === 'APPROVED'
  const changes = item.reviewState === 'CHANGES_REQUESTED'
  const long = item.body.length > 450 || item.body.split('\n').length > 8
  const verb = commentVerb(item, threads.length)
  return (
    <TimelineEvent icon={approved ? 'checkmark' : changes ? 'doc.text' : 'text.bubble'} {...(approved ? { tone: 'success' as const } : changes ? { tone: 'danger' as const } : {})}>
      <EventHeader author={item.author} {...(item.authorAvatarUrl ? { avatarUrl: item.authorAvatarUrl } : {})} verb={verb} at={item.createdAt} now={now} />
      {item.body.trim() ? (
        <View className="gap-2 overflow-hidden rounded-2xl bg-grouped-card p-3">
          <View style={long && !expanded ? { maxHeight: 240, overflow: 'hidden' } : undefined}>
            <PullRequestMarkdown markdown={long && !expanded ? item.body.slice(0, 1200) : item.body} />
          </View>
          {long ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} hitSlop={8} className="flex-row items-center justify-center gap-1 py-2 active:opacity-70">
              <Text className="text-xs font-t3-medium text-foreground">{expanded ? 'Show less' : 'Show more'}</Text>
              <SymbolView name={expanded ? 'chevron.up' : 'chevron.down'} size={10} tintColorClassName="accent-foreground" />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {threads.map((thread) => <ThreadCard key={thread.id} thread={thread} onOpen={onOpenThread} />)}
    </TimelineEvent>
  )
}

function conversationRow(item: PrConversationItem, threads: readonly ReviewThread[], now: number, onOpenThread: (threadId: string) => void): ActivityRow {
  if (item.kind !== 'label') return { key: `comment:${item.id}`, date: item.createdAt, content: <TimelineComment item={item} threads={threads} now={now} onOpenThread={onOpenThread} /> }
  const color = pullRequestLabelColor(item.label.color)
  return {
    key: `label:${item.id}`,
    date: item.createdAt,
    content: (
      <TimelineEvent icon="pencil">
        <EventHeader author={item.author} {...(item.authorAvatarUrl ? { avatarUrl: item.authorAvatarUrl } : {})} verb={`${item.action} the label`} at={item.createdAt} now={now} />
        <View className="flex-row items-center gap-1.5 self-start rounded-full bg-grouped-card px-3 py-1">
          {color ? <View className="size-2 rounded-full" style={{ backgroundColor: color }} /> : null}
          <Text className="text-2xs text-foreground-muted">{item.label.name}</Text>
        </View>
      </TimelineEvent>
    ),
  }
}

function threadRow(thread: ReviewThread, now: number, onOpen: (threadId: string) => void): ActivityRow {
  const first = thread.comments[0]
  return {
    key: `discussion:${thread.id}`,
    date: first?.createdAt ?? '',
    content: (
      <TimelineEvent icon="text.bubble" {...(thread.isResolved ? { tone: 'success' as const } : {})}>
        <EventHeader author={first?.author ?? 'Unknown author'} {...(first?.authorAvatarUrl ? { avatarUrl: first.authorAvatarUrl } : {})} verb="started a discussion" at={first?.createdAt ?? ''} now={now} />
        <ThreadCard thread={thread} onOpen={onOpen} />
      </TimelineEvent>
    ),
  }
}

function commitRow(commit: PrCommit, now: number, onOpen: (sha: string) => void): ActivityRow {
  return {
    key: `commit:${commit.sha}`,
    date: commit.committedAt,
    content: (
      <TimelineEvent icon="circle">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`View commit ${commit.sha.slice(0, 7)}, ${commit.message}`}
          onPress={() => onOpen(commit.sha)}
          className="flex-row items-center gap-2 active:opacity-70"
        >
          <PullRequestAvatar login={commit.author} size={22} />
          <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>{commit.message}</Text>
          <Text className="text-2xs text-foreground-muted" style={{ fontFamily: CODE_FONT }}>{commit.sha.slice(0, 7)}</Text>
          <Text className="text-2xs text-foreground-tertiary">{prAge(commit.committedAt, now)}</Text>
        </Pressable>
      </TimelineEvent>
    ),
  }
}

/** The timeline in date order, newest first when the filter asks. A review's
 *  threads ride in its row; a thread without a review has its own. */
export function pullRequestActivityRows(
  activity: PullRequestActivity,
  newestFirst: boolean,
  handlers: { readonly openThread: (threadId: string) => void; readonly openCommit: (sha: string) => void },
): ActivityRow[] {
  const now = Date.now()
  const groups = groupThreadsByReview(activity.comments, activity.threads)
  const rows = [
    ...activity.comments.flatMap((item) => {
      const threads = item.kind === 'review' ? groups.byReview.get(item.id) ?? [] : []
      if (item.kind === 'review' && !reviewIsEvent(item, threads)) return []
      return [conversationRow(item, threads, now, handlers.openThread)]
    }),
    ...groups.standalone.map((thread) => threadRow(thread, now, handlers.openThread)),
    ...activity.commits.map((commit) => commitRow(commit, now, handlers.openCommit)),
  ].sort((a, b) => a.date.localeCompare(b.date))
  return newestFirst ? rows.reverse() : rows
}

const KINDS = [
  { id: 'all', title: 'All activity' },
  { id: 'comments', title: 'Comments' },
  { id: 'commits', title: 'Commits' },
] as const

export function PullRequestActivityFilters(props: { readonly value: ActivityFilter; readonly onChange: (value: ActivityFilter) => void; readonly hiddenCount: number }) {
  const { value, onChange } = props
  const kindTitle = KINDS.find((kind) => kind.id === value.kind)?.title
  return (
    <View className="mb-4 flex-row items-center justify-between gap-3">
      <ControlPillMenu
        title="Activity"
        actions={KINDS.map((kind) => ({ ...kind, state: value.kind === kind.id ? 'on' as const : 'off' as const }))}
        onPressAction={({ nativeEvent }) => {
          const kind = KINDS.find((item) => item.id === nativeEvent.event)
          if (kind) onChange({ ...value, kind: kind.id })
        }}
      >
        <Pressable accessibilityRole="button" accessibilityLabel={`Activity type, ${kindTitle}`} className="min-h-11 flex-row items-center gap-2 active:opacity-60">
          <Text className="text-sm font-t3-semibold">{kindTitle}</Text>
          <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </ControlPillMenu>
      <View className="flex-row items-center gap-3">
        <ControlPillMenu
          title="Show in activity"
          actions={[
            { id: 'bots', title: 'Bot comments', state: value.bots ? 'on' : 'off' },
            { id: 'resolved', title: 'Resolved or dismissed', state: value.resolved ? 'on' : 'off' },
          ]}
          onPressAction={({ nativeEvent: { event } }) => {
            if (event === 'bots' || event === 'resolved') onChange({ ...value, [event]: !value[event] })
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel={`Filter activity, ${props.hiddenCount} hidden`} className="min-h-11 flex-row items-center gap-1.5 active:opacity-60">
            {props.hiddenCount > 0 ? <Text className="text-xs text-foreground-muted">{props.hiddenCount} hidden</Text> : null}
            <SymbolView name="line.3.horizontal.decrease" size={18} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </ControlPillMenu>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value.newestFirst ? 'Newest first' : 'Oldest first'}
          onPress={() => onChange({ ...value, newestFirst: !value.newestFirst })}
          className="h-11 flex-row items-center gap-1 active:opacity-60"
        >
          <SymbolView name={value.newestFirst ? 'arrow.down' : 'arrow.up'} size={18} tintColorClassName="accent-icon-muted" />
          <Text className="text-xs text-foreground-muted">{value.newestFirst ? 'Newest' : 'Oldest'}</Text>
        </Pressable>
      </View>
    </View>
  )
}
