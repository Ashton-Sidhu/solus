// Adapted from T3 Code apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx and features/home/thread-swipe-actions.tsx (MIT, see UPSTREAM.md).
import { useCallback, useState, type ComponentProps } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { Alert, FlatList, Pressable, RefreshControl, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { NotificationPr, NotificationView } from '@solus/contracts/notification-hub'
import { hubRowKey, type HubRow } from '@solus/client-core/notifications/merge'
import { notificationAge, notificationError, notificationHeadline, sourceStatusNote, unreadCountLabel } from '@solus/client-core/notifications/presentation'
import { attributionLabel } from '@solus/contracts/user'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import { SegmentedControl } from '../../components/SegmentedControl'
import { cn } from '../../lib/cn'
import type { ScreenProps } from '../../navigation/routes'
import { nativeDestination } from './lib/native-destinations'

const VIEWS: { value: NotificationView; label: string }[] = [
  { value: 'all', label: 'Inbox' },
  { value: 'unread', label: 'Unread' },
  { value: 'archived', label: 'Archived' },
]

/** Every host's notifications addressed to you, with read and archive (plan 015). */
export function NotificationsScreen({ navigation }: ScreenProps<'Notifications'>) {
  const app = useApp()
  useFocusEffect(useCallback(() => app.notifications.showHistory(), [app]))
  const hub = useListened(app.notifications.changes, app.notifications.snapshot)
  const insets = useSafeAreaInsets()
  const [isRefreshing, setRefreshing] = useState(false)
  // Select mode: a tap toggles a row instead of opening it. A key whose row left
  // the list counts for nothing, so the count and the actions cover visible rows only.
  const [isSelecting, setSelecting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set())
  const visibleKeys = hub.entries.map((row) => hubRowKey(row.sourceId, row.notification.id))
  const selected = visibleKeys.filter((key) => selectedKeys.has(key))
  const count = unreadCountLabel(hub.unread)
  const troubled = hub.sources.filter((state) => state.status === 'offline' || state.status === 'unsupported')
  const isLoading = hub.sources.some((state) => state.status === 'loading')
  const now = Date.now()

  const refresh = () => {
    setRefreshing(true)
    void app.notifications.refresh().finally(() => setRefreshing(false))
  }

  const choose = async (row: HubRow, change: (key: string) => Promise<boolean>) => {
    if (await change(hubRowKey(row.sourceId, row.notification.id))) return
    Alert.alert('Not changed', 'The host did not confirm the change. The list shows what it holds now.')
  }

  const endSelecting = () => {
    setSelecting(false)
    setSelectedKeys(new Set())
  }

  const toggleSelected = (key: string) => {
    const next = new Set(selectedKeys)
    if (!next.delete(key)) next.add(key)
    setSelectedKeys(next)
  }

  const applyToSelected = async (change: (keys: string[]) => Promise<number>) => {
    const keys = selected
    endSelecting()
    const refused = await change(keys)
    if (refused > 0) Alert.alert('Not changed', `The hosts did not confirm ${refused} of ${keys.length} notifications. The list shows what they hold now.`)
  }

  const open = (row: HubRow) => {
    const key = hubRowKey(row.sourceId, row.notification.id)
    if (row.notification.readAt === null && app.notifications.canChange(key)) void app.notifications.setRead(key, true)
    const destination = nativeDestination(row.notification)
    if (destination.kind === 'none') return
    if (destination.kind === 'unsupported') {
      Alert.alert(row.notification.summary.title, destination.message)
      return
    }
    if (destination.kind === 'pull-request') {
      void openPullRequest(row, destination.pr)
      return
    }
    // The session is on the host that sent the notification; that host checks access when it opens.
    const hostId = hostIdOf(row)
    if (hostId) navigation.navigate('Thread', { hostId, sessionId: destination.sessionId })
    else Alert.alert(row.notification.summary.title, 'Open this session in Solus on your computer or on the web.')
  }

  // The host that sent the notification is asked first, then every other host.
  const openPullRequest = async (row: HubRow, pr: NotificationPr) => {
    const sourceHostId = hostIdOf(row)
    const hostIds = app.registry.hosts().map((host) => host.id).sort((a, b) => Number(b === sourceHostId) - Number(a === sourceHostId))
    const found = await app.pullRequests.locate(pr, hostIds)
    if (found) {
      navigation.navigate('PullRequest', found)
      return
    }
    const url = pr.url
    Alert.alert(row.notification.summary.title, `No connected host has a project for ${pr.owner}/${pr.repo}.`, [
      ...(url ? [{ text: 'Open on GitHub', onPress: () => void app.platform.openBrowser(url) }] : []),
      { text: 'OK', style: 'cancel' as const },
    ])
  }

  return (
    <View className="flex-1 bg-sheet">
      <FlatList
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: isSelecting ? 152 : 32, paddingHorizontal: 16, paddingTop: 4 }}
        data={hub.entries}
        keyExtractor={(row) => hubRowKey(row.sourceId, row.notification.id)}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={refresh} tintColorClassName="accent-icon" />}
        ListHeaderComponent={
          <View className="gap-3 pb-4 pt-2">
            <SegmentedControl
              role="tab"
              options={VIEWS.map((view) => ({ value: view.value, label: view.value === 'unread' && count ? `${view.label} ${count}` : view.label }))}
              selected={hub.view}
              onSelect={(view) => {
                endSelecting()
                app.notifications.setView(view)
              }}
            />
            {hub.entries.length > 0 && !isSelecting ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setSelecting(true)}
                hitSlop={8}
                className="self-end active:opacity-70"
              >
                <Text className="text-sm font-t3-medium text-foreground">Select</Text>
              </Pressable>
            ) : null}
            {troubled.map((state) => (
              <View
                key={state.source.sourceId}
                className={cn('rounded-[20px] border p-4', state.status === 'offline' ? 'border-danger-border bg-danger' : 'border-warning-border bg-warning')}
              >
                <Text className={cn('text-base font-t3-bold', state.status === 'offline' ? 'text-danger-foreground' : 'text-warning-foreground')}>
                  {state.source.label}
                </Text>
                <Text className="mt-1 text-sm text-foreground-muted">{sourceStatusNote(state)}</Text>
              </View>
            ))}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={isLoading ? 'Loading notifications' : hub.view === 'archived' ? 'Nothing archived' : hub.view === 'unread' ? 'You are caught up' : 'No notifications yet'}
            detail={isLoading ? 'Reading from your connected hosts.' : 'Review requests, assignments, and finished runs addressed to you appear here.'}
          />
        }
        renderItem={({ item: row, index }) => {
          const key = hubRowKey(row.sourceId, row.notification.id)
          const isSelected = selectedKeys.has(key)
          const canChange = app.notifications.canChange(key)
          const isUnread = row.notification.readAt === null
          const isArchived = row.notification.archivedAt !== null
          const isFirst = index === 0
          const isLast = index === hub.entries.length - 1
          const label = hub.sources.find((state) => state.source.sourceId === row.sourceId)?.source.label ?? ''
          const error = notificationError(row.notification)
          const subtitle = [notificationHeadline(row.notification), attributionLabel(row.notification.by), label].filter(Boolean).join(' · ')
          return (
            <View className={cn('overflow-hidden bg-grouped-card', isFirst && 'rounded-t-[20px]', isLast && 'rounded-b-[20px]')}>
              <View className={cn('flex-row items-center gap-3 px-4 py-3', !isLast && 'border-b border-separator')}>
                <Pressable
                  {...rowAccessibility(isSelecting, isSelected)}
                  accessibilityLabel={`${isUnread ? 'Unread. ' : ''}${row.notification.summary.title}`}
                  onPress={() => (isSelecting ? toggleSelected(key) : open(row))}
                  onLongPress={() => {
                    setSelecting(true)
                    toggleSelected(key)
                  }}
                  className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
                >
                  {isSelecting ? (
                    <SymbolView name={isSelected ? 'checkmark.circle' : 'circle'} size={22} tintColorClassName="accent-icon" type="monochrome" />
                  ) : null}
                  <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-subtle">
                    <SymbolView name={isArchived ? 'archivebox.fill' : 'bell.badge'} size={15} tintColorClassName="accent-icon-subtle" type="monochrome" />
                    {isUnread ? <View className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full bg-primary" /> : null}
                  </View>
                  <View className="min-w-0 flex-1 gap-1">
                    <Text
                      className={cn('min-w-0 text-base leading-snug text-foreground', isUnread ? 'font-t3-bold' : 'font-t3-medium')}
                      numberOfLines={1}
                    >
                      {row.notification.summary.title}
                    </Text>
                    {subtitle ? <Text className="min-w-0 text-2xs text-foreground-tertiary" numberOfLines={1}>{subtitle}</Text> : null}
                    {error ? <Text className="text-2xs text-adaptive-rose-600-400" numberOfLines={2}>{error}</Text> : null}
                  </View>
                </Pressable>
                <Text className="min-w-[30px] text-right text-xs tabular-nums text-foreground-tertiary">
                  {notificationAge(row.notification.createdAt, now)}
                </Text>
                {isSelecting ? null : (
                  <>
                    <RowAction
                      icon={isUnread ? 'checkmark.circle' : 'circle'}
                      accessibilityLabel={isUnread ? `Mark ${row.notification.summary.title} read` : `Mark ${row.notification.summary.title} unread`}
                      disabled={!canChange}
                      onPress={() => void choose(row, (rowKey) => app.notifications.setRead(rowKey, isUnread))}
                    />
                    <RowAction
                      icon={isArchived ? 'arrow.uturn.backward' : 'archivebox'}
                      accessibilityLabel={`${isArchived ? 'Restore' : 'Archive'} ${row.notification.summary.title}`}
                      disabled={!canChange}
                      onPress={() => void choose(row, (rowKey) => app.notifications.setArchived(rowKey, !isArchived))}
                    />
                  </>
                )}
              </View>
            </View>
          )
        }}
        ListFooterComponent={
          <View className="gap-4 pt-4">
            {hub.hasMore ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void app.notifications.loadMore()}
                className="min-h-11 self-center justify-center rounded-full bg-subtle px-4 active:opacity-70"
              >
                <Text className="text-sm font-t3-medium text-foreground">Load more</Text>
              </Pressable>
            ) : null}
            <Text className="px-1 text-xs leading-snug text-foreground-muted">
              Hosts that cannot be reached keep showing what was loaded; their read and archive controls are off until they answer.
            </Text>
          </View>
        }
      />
      {isSelecting ? (
        <View className="absolute inset-x-0 bottom-0 gap-2 border-t border-separator bg-grouped-card px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-t3-medium tabular-nums text-foreground">{selected.length} selected</Text>
            <View className="flex-row items-center gap-4">
              {selected.length < visibleKeys.length ? <BulkAction label="Select all" onPress={() => setSelectedKeys(new Set(visibleKeys))} /> : null}
              <BulkAction label="Cancel" onPress={endSelecting} />
            </View>
          </View>
          <View className="flex-row items-center justify-between">
            <BulkAction label="Read" disabled={selected.length === 0} onPress={() => void applyToSelected((keys) => app.notifications.setReadMany(keys, true))} />
            <BulkAction label="Unread" disabled={selected.length === 0} onPress={() => void applyToSelected((keys) => app.notifications.setReadMany(keys, false))} />
            {hub.view === 'archived' ? (
              <BulkAction label="Restore" disabled={selected.length === 0} onPress={() => void applyToSelected((keys) => app.notifications.setArchivedMany(keys, false))} />
            ) : (
              <BulkAction label="Archive" disabled={selected.length === 0} onPress={() => void applyToSelected((keys) => app.notifications.setArchivedMany(keys, true))} />
            )}
          </View>
        </View>
      ) : null}
    </View>
  )
}

/** A row reads as a checkbox in select mode, and as a button otherwise. */
function rowAccessibility(isSelecting: boolean, isSelected: boolean) {
  return isSelecting
    ? { accessibilityRole: 'checkbox', accessibilityState: { checked: isSelected }, accessibilityHint: 'Adds it to the selection or removes it' } as const
    : { accessibilityRole: 'button', accessibilityHint: 'Marks it read and says where it opens' } as const
}

/** The host a host source names; null for a source that is not a host. */
function hostIdOf(row: HubRow): string | null {
  return row.sourceId.startsWith('host:') ? row.sourceId.slice('host:'.length) : null
}

/** T3 Code's swipe action, shown in the row as a small circle. */
function RowAction(props: {
  readonly icon: ComponentProps<typeof SymbolView>['name']
  readonly accessibilityLabel: string
  readonly disabled: boolean
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={8}
      className="h-7 w-7 items-center justify-center rounded-full bg-secondary active:opacity-70 disabled:opacity-[0.45]"
    >
      <SymbolView name={props.icon} size={13} tintColorClassName="accent-secondary-foreground" type="monochrome" />
    </Pressable>
  )
}

function BulkAction(props: { readonly label: string; readonly disabled?: boolean; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70 disabled:opacity-[0.45]"
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  )
}
