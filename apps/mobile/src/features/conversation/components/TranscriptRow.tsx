import { memo, useCallback, useState, useSyncExternalStore } from 'react'
import { Text, TextInput, View } from 'react-native'
import { usePalette } from '../../../theme/theme'
import { radius, space, type } from '../../../theme/tokens'
import { Button } from '../../../ui/primitives'
import type { ConversationStore } from '../conversation-store'
import type { TranscriptItem } from '../lib/transcript-model'
import { MarkdownText } from './MarkdownText'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../../navigation/routes'

/** One transcript row. It subscribes to its own item only. */
export const TranscriptRow = memo(function TranscriptRow({ store, id }: { store: ConversationStore; id: string }) {
  const subscribe = useCallback((listener: () => void) => store.subscribeItem(id, listener), [store, id])
  const read = useCallback(() => store.item(id), [store, id])
  const item = useSyncExternalStore(subscribe, read, read)
  if (!item) return null
  return <View style={{ paddingHorizontal: space.lg, paddingVertical: space.sm }}><RowBody store={store} item={item} /></View>
})

function RowBody({ store, item }: { store: ConversationStore; item: TranscriptItem }) {
  const palette = usePalette()
  switch (item.kind) {
    case 'user':
      return <UserBubble store={store} item={item} />
    case 'assistant':
      return <MarkdownText text={item.text} />
    case 'tool':
      return (
        <View accessible accessibilityLabel={`Tool ${item.toolName}, ${item.status}`} style={{ borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, padding: space.sm, gap: 2 }}>
          <Text style={{ color: item.status === 'error' ? palette.danger : palette.textSecondary, fontSize: type.dense, fontWeight: '600' }}>
            {item.status === 'running' ? '◌ ' : item.status === 'error' ? '✕ ' : '✓ '}{item.toolName}
            {item.childCount ? `  · ${item.childCount} steps` : ''}
          </Text>
          {item.input ? <Text numberOfLines={2} style={{ color: palette.textTertiary, fontSize: type.dense }}>{item.input}</Text> : null}
          {item.errorHead ? <Text numberOfLines={3} style={{ color: palette.danger, fontSize: type.dense }}>{item.errorHead}</Text> : null}
        </View>
      )
    case 'notice':
      return <Text style={{ color: item.tone === 'error' ? palette.danger : palette.textTertiary, fontSize: type.dense, textAlign: 'center' }}>{item.text}</Text>
    case 'plan':
      return <PlanCard store={store} plan={item} />
    case 'build':
      return <BuildCard hostId={store.controller.hostId} item={item} />
  }
}

function BuildCard({ hostId, item }: { hostId: string; item: Extract<TranscriptItem, { kind: 'build' }> }) {
  const palette = usePalette()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const detail = item.build.installedOn ? `Installed on ${item.build.installedOn}` : item.build.appId ?? 'App build'
  return (
    <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, padding: space.sm, gap: space.sm, flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: palette.text, fontSize: type.chrome, fontWeight: '600' }}>{item.build.name}</Text>
        <Text numberOfLines={1} style={{ color: palette.textTertiary, fontSize: type.dense }}>{detail}</Text>
      </View>
      <Button label="Builds" accessibilityHint="Opens App builds, where you can install it" onPress={() => navigation.navigate('Builds', { hostId })} />
    </View>
  )
}

function UserBubble({ store, item }: { store: ConversationStore; item: Extract<TranscriptItem, { kind: 'user' }> }) {
  const palette = usePalette()
  return (
    <View style={{ alignSelf: 'flex-end', maxWidth: '88%', gap: space.xs }}>
      <View style={{ backgroundColor: palette.userBubble, borderRadius: radius.lg, padding: space.md }}>
        {item.text ? <Text selectable style={{ color: palette.text, fontSize: type.body, lineHeight: 22 }}>{item.text}</Text> : null}
        {item.attachmentCount ? <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>{item.attachmentCount === 1 ? '1 attachment' : `${item.attachmentCount} attachments`}</Text> : null}
      </View>
      {item.delivery === 'sending' ? <Text style={{ color: palette.textTertiary, fontSize: type.dense, textAlign: 'right' }}>Sending…</Text> : null}
      {item.delivery === 'queued' ? <Text style={{ color: palette.textTertiary, fontSize: type.dense, textAlign: 'right' }}>Waiting for the host</Text> : null}
      {item.delivery === 'failed' ? (
        <View style={{ gap: space.xs, alignItems: 'flex-end' }}>
          <Text style={{ color: palette.danger, fontSize: type.dense }}>Not sent{item.error ? `: ${item.error}` : ''}</Text>
          {item.error !== 'Not sent.' ? (
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button label="Send again" onPress={() => void store.controller.retry(item.id)} />
              <Button tone="plain" label="Remove" onPress={() => store.controller.discard(item.id)} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function PlanCard({ store, plan }: { store: ConversationStore; plan: Extract<TranscriptItem, { kind: 'plan' }> }) {
  const palette = usePalette()
  const [expanded, setExpanded] = useState(plan.decision === 'pending')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const decide = async (approve: boolean) => {
    setBusy(true)
    try {
      if (approve) await store.controller.approvePlan(plan, comment)
      else await store.controller.requestPlanChanges(plan, comment)
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: palette.accent, backgroundColor: palette.card, padding: space.md, gap: space.sm }}>
      <Text style={{ color: palette.accent, fontSize: type.dense, fontWeight: '700' }}>
        {plan.decision === 'pending' ? 'PLAN — WAITING FOR YOUR DECISION' : plan.decision === 'accepted' ? 'PLAN — APPROVED' : plan.decision === 'rejected' ? 'PLAN — CHANGES REQUESTED' : 'PLAN'}
      </Text>
      {expanded ? <MarkdownText text={plan.content} /> : <Text numberOfLines={3} style={{ color: palette.text, fontSize: type.body }}>{plan.content}</Text>}
      <Button tone="plain" label={expanded ? 'Show less' : 'Show the whole plan'} onPress={() => setExpanded(!expanded)} />
      {plan.decision === 'pending' ? (
        <>
          <TextInput
            accessibilityLabel="Notes for the agent"
            placeholder="Notes (optional)"
            placeholderTextColor={palette.textTertiary}
            value={comment}
            onChangeText={setComment}
            multiline
            style={{ minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, padding: space.sm, color: palette.text, fontSize: type.body }}
          />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}><Button tone="primary" label="Approve" busy={busy} onPress={() => void decide(true)} /></View>
            <View style={{ flex: 1 }}><Button label="Request changes" disabled={busy} onPress={() => void decide(false)} /></View>
          </View>
        </>
      ) : null}
    </View>
  )
}
