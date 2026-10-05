import { useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { usePalette } from '../../../theme/theme'
import { radius, space, type } from '../../../theme/tokens'
import { Button } from '../../../ui/primitives'
import type { ConversationStore } from '../conversation-store'
import type { AgentPlanAwaiting } from '../lib/agent-plans'
import { MarkdownText } from './MarkdownText'

/** A plan another session wrote for work this one sent it. Approving or asking
 *  for changes acts on that session; this conversation sends nothing. */
export function AgentPlanCard({ store, plan }: { store: ConversationStore; plan: AgentPlanAwaiting }) {
  const palette = usePalette()
  const [revising, setRevising] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const decide = async (decision: 'approve' | 'request_changes') => {
    setBusy(true)
    try {
      await store.controller.decideAgentPlan(plan, decision, comment)
    } finally {
      setBusy(false)
    }
  }
  return (
    <View accessibilityRole="alert" style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: palette.accent, backgroundColor: palette.card, padding: space.md, gap: space.sm }}>
      <Text style={{ color: palette.accent, fontSize: type.dense, fontWeight: '700' }}>PLAN FROM {plan.sessionTitle.toUpperCase()}</Text>
      <Text style={{ color: palette.text, fontSize: type.chrome, fontWeight: '600' }}>{plan.planTitle}</Text>
      {plan.content ? <MarkdownText text={plan.content} /> : null}
      {revising ? (
        <>
          <TextInput
            accessibilityLabel="What should change?"
            placeholder="What should change?"
            placeholderTextColor={palette.textTertiary}
            value={comment}
            onChangeText={setComment}
            multiline
            autoFocus
            style={{ minHeight: 60, borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, padding: space.sm, color: palette.text, fontSize: type.body }}
          />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}><Button tone="primary" label="Send changes" busy={busy} disabled={!comment.trim()} onPress={() => void decide('request_changes')} /></View>
            <View style={{ flex: 1 }}><Button label="Cancel" disabled={busy} onPress={() => setRevising(false)} /></View>
          </View>
        </>
      ) : (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}><Button tone="primary" label="Approve" busy={busy} onPress={() => void decide('approve')} /></View>
          <View style={{ flex: 1 }}><Button label="Request changes" disabled={busy} onPress={() => setRevising(true)} /></View>
        </View>
      )}
    </View>
  )
}
