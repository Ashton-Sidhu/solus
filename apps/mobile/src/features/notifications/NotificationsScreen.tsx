import { useState } from 'react'
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native'
import type { NotificationPr, NotificationView } from '@solus/contracts/notification-hub'
import { hubRowKey, type HubRow } from '@solus/client-core/notifications/merge'
import { notificationAge, notificationError, notificationHeadline, sourceStatusNote, unreadCountLabel } from '@solus/client-core/notifications/presentation'
import { attributionLabel } from '@solus/contracts/user'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space, type } from '../../theme/tokens'
import { Banner, Button, EmptyState, Row } from '../../ui/primitives'
import { nativeDestination } from './lib/native-destinations'

const VIEWS: { value: NotificationView; label: string }[] = [
  { value: 'all', label: 'Inbox' },
  { value: 'unread', label: 'Unread' },
  { value: 'archived', label: 'Archived' },
]

/** Every host's notifications addressed to you, with read and archive (plan 015). */
export function NotificationsScreen({ navigation }: ScreenProps<'Notifications'>) {
  const app = useApp()
  const palette = usePalette()
  const hub = useListened(app.notifications.changes, app.notifications.snapshot)
  const [isRefreshing, setRefreshing] = useState(false)
  const count = unreadCountLabel(hub.unread)
  const troubled = hub.sources.filter((state) => state.status === 'offline' || state.status === 'unsupported')

  const refresh = () => {
    setRefreshing(true)
    void app.notifications.refresh().finally(() => setRefreshing(false))
  }

  const choose = async (row: HubRow, change: (key: string) => Promise<boolean>) => {
    if (await change(hubRowKey(row.sourceId, row.notification.id))) return
    Alert.alert('Not changed', 'The host did not confirm the change. The list shows what it holds now.')
  }

  const open = (row: HubRow) => {
    const key = hubRowKey(row.sourceId, row.notification.id)
    if (row.notification.readAt === null && app.notifications.canChange(key)) void app.notifications.setRead(key, true)
    const destination = nativeDestination(row.notification.resource)
    if (destination.kind === 'unsupported') {
      Alert.alert(row.notification.summary.title, destination.message)
      return
    }
    void openPullRequest(row, destination.pr)
  }

  // The host that sent the notification is asked first, then every other host.
  const openPullRequest = async (row: HubRow, pr: NotificationPr) => {
    const sourceHostId = row.sourceId.startsWith('host:') ? row.sourceId.slice('host:'.length) : null
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
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={refresh} />}
    >
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm }}>
        {VIEWS.map((view) => (
          <Button
            key={view.value}
            tone={hub.view === view.value ? 'primary' : 'secondary'}
            label={view.value === 'unread' && count ? `${view.label} ${count}` : view.label}
            onPress={() => app.notifications.setView(view.value)}
          />
        ))}
      </View>
      {troubled.map((state) => (
        <View key={state.source.sourceId} style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          <Banner tone={state.status === 'offline' ? 'error' : 'info'} message={`${state.source.label}: ${sourceStatusNote(state)}`} />
        </View>
      ))}
      {hub.entries.length === 0 ? (
        <EmptyState
          title={hub.view === 'archived' ? 'Nothing archived' : hub.view === 'unread' ? 'You are caught up' : 'No notifications yet'}
          message="Review requests, assignments, and finished runs addressed to you appear here."
        />
      ) : (
        hub.entries.map((row) => {
          const key = hubRowKey(row.sourceId, row.notification.id)
          const canChange = app.notifications.canChange(key)
          const isUnread = row.notification.readAt === null
          const isArchived = row.notification.archivedAt !== null
          const label = hub.sources.find((state) => state.source.sourceId === row.sourceId)?.source.label ?? ''
          const error = notificationError(row.notification)
          return (
            <Row
              key={key}
              title={`${isUnread ? '● ' : ''}${row.notification.summary.title}`}
              subtitle={[notificationHeadline(row.notification), attributionLabel(row.notification.by), label, notificationAge(row.notification.createdAt, Date.now()), error].filter(Boolean).join(' · ')}
              onPress={() => open(row)}
              accessibilityHint="Marks it read and says where it opens"
              trailing={<View style={{ flexDirection: 'row', gap: space.xs }}>
                <Button tone="plain" label={isUnread ? 'Read' : 'Unread'} disabled={!canChange} accessibilityHint={isUnread ? 'Marks it as read' : 'Marks it as unread'} onPress={() => void choose(row, (rowKey) => app.notifications.setRead(rowKey, isUnread))} />
                <Button tone="plain" label={isArchived ? 'Restore' : 'Archive'} disabled={!canChange} onPress={() => void choose(row, (rowKey) => app.notifications.setArchived(rowKey, !isArchived))} />
              </View>}
            />
          )
        })
      )}
      {hub.hasMore ? (
        <View style={{ padding: space.lg }}>
          <Button label="Load more" onPress={() => void app.notifications.loadMore()} />
        </View>
      ) : null}
      <Text style={{ color: palette.textTertiary, fontSize: type.dense, padding: space.lg }}>
        Hosts that cannot be reached keep showing what was loaded; their read and archive controls are off until they answer.
      </Text>
    </ScrollView>
  )
}
