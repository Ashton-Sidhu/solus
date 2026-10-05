import { useCallback, useMemo, useRef } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type TextInput } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import { usePalette } from '../../theme/theme'
import { CONVERSATION_MAX_WIDTH } from '../layout/lib/layout'
import { space, type } from '../../theme/tokens'
import { Banner, Button } from '../../ui/primitives'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import type { ConversationStore } from './conversation-store'
import { Composer } from './components/Composer'
import { RequestPanel } from './components/RequestPanel'
import { RunSettingsBar } from './components/RunSettingsBar'
import { QueuePanel } from './components/QueuePanel'
import { AttachmentChips } from './components/AttachmentBar'
import { TranscriptRow } from './components/TranscriptRow'
import { useKeyboardCommand } from '../keyboard/use-keyboard-command'
import { isSessionBusyStatus } from '@solus/contracts/types'

/**
 * One conversation: transcript, waiting requests, and the composer. The list
 * is inverted so the newest row sits at the bottom and a reader scrolled into
 * older content stays where they are while new rows arrive.
 */
export function ConversationPane({ store, conversationId }: { store: ConversationStore; conversationId: string }) {
  const app = useApp()
  const palette = usePalette()
  const order = useListened(store.order, store.orderSnapshot)
  const meta = useListened(store.meta, store.metaSnapshotOf)
  const composer = useRef<TextInput>(null)
  const phase = useListened(app.connections.changes, () => app.connections.state(store.controller.hostId)?.phase)
  // Newest first for the inverted list; recomputed only when rows are added.
  const rows = useMemo(() => [...order].reverse(), [order])
  const initialOffset = useRef(store.scrollOffset)
  // Stop applies only to a running turn; otherwise the command passes on.
  useKeyboardCommand('stop', () => {
    if (!isSessionBusyStatus(meta.status)) return false
    void store.controller.stop()
  })

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    store.scrollOffset = event.nativeEvent.contentOffset.y
    store.readerAtEnd = store.scrollOffset < 24
  }, [store])

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.canvas }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <View style={{ flex: 1, width: '100%', maxWidth: CONVERSATION_MAX_WIDTH, alignSelf: 'center' }}>
        <HostStatusBanner hostId={store.controller.hostId} />
        {meta.phase.kind === 'error' ? (
          <View style={{ padding: space.lg }}>
            <Banner message={`This conversation could not be opened: ${meta.phase.message}`} action={<Button label="Try again" onPress={() => void store.controller.load()} />} />
          </View>
        ) : null}
        {meta.phase.kind === 'loading' && order.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator accessibilityLabel="Loading the conversation" /></View>
        ) : (
          <FlatList
            inverted
            data={rows}
            keyExtractor={(id) => id}
            renderItem={({ item }) => <TranscriptRow store={store} id={item} />}
            contentOffset={{ x: 0, y: initialOffset.current }}
            onScroll={onScroll}
            scrollEventThrottle={64}
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 24 }}
            onEndReached={() => void store.controller.loadOlder()}
            onEndReachedThreshold={0.4}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={meta.loadingOlder ? <ActivityIndicator style={{ padding: space.lg }} /> : !meta.hasOlder && order.length ? <Text style={{ color: palette.textTertiary, fontSize: type.dense, textAlign: 'center', padding: space.lg }}>Start of conversation</Text> : null}
            ListEmptyComponent={meta.phase.kind === 'ready' ? <Text style={{ color: palette.textTertiary, fontSize: type.chrome, textAlign: 'center', padding: space.xl, transform: [{ scaleY: -1 }] }}>Send a message to start.</Text> : null}
          />
        )}
        <RequestPanel store={store} meta={meta} />
        <QueuePanel store={store} meta={meta} onClose={() => composer.current?.focus()} />
        <RunSettingsBar store={store} meta={meta} onClose={() => composer.current?.focus()} />
        <AttachmentChips store={store} meta={meta} />
        <Composer ref={composer} store={store} conversationId={conversationId} meta={meta} disabled={meta.phase.kind !== 'ready' || phase === 'blocked'} />
      </View>
    </KeyboardAvoidingView>
  )
}
