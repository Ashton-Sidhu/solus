import { useEffect, useState } from 'react'
import { Modal, ScrollView, Text, TextInput, View } from 'react-native'
import { usePalette } from '../../../theme/theme'
import { space } from '../../../theme/tokens'
import { Button } from '../../../ui/primitives'

/** What the sheet writes: a conversation comment, or a review with a verdict. */
export type PrComposerIntent =
  | { kind: 'comment' }
  | { kind: 'review'; verdict: 'approve' | 'request-changes' }

const TITLES = {
  comment: 'Add comment',
  approve: 'Approve',
  'request-changes': 'Request changes',
} as const

/**
 * T3 Code's comment sheet (`ReviewCommentComposerSheet.tsx`), without a line
 * target: the phone comments on the pull request as a whole. A comment and a
 * change request need words; an approval may stand alone.
 */
export function PrComposerSheet({ intent, prTitle, onSubmit, onClose }: {
  intent: PrComposerIntent | null
  prTitle: string
  onSubmit: (intent: PrComposerIntent, body: string) => Promise<void>
  onClose: () => void
}) {
  const palette = usePalette()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!intent) return
    setBody('')
    setError('')
  }, [intent])

  if (!intent) return null
  const title = TITLES[intent.kind === 'comment' ? 'comment' : intent.verdict]
  const needsBody = !(intent.kind === 'review' && intent.verdict === 'approve')
  const canSend = !busy && (!needsBody || body.trim().length > 0)

  const send = async () => {
    setBusy(true)
    setError('')
    try {
      await onSubmit(intent, body)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ paddingHorizontal: 17.5, paddingTop: space.lg, paddingBottom: space.xl, gap: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button tone="plain" label="Cancel" onPress={onClose} />
          <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 18, fontWeight: '700' }}>{title}</Text>
          <Button tone="primary" label={intent.kind === 'comment' ? 'Comment' : 'Submit'} disabled={!canSend} busy={busy} onPress={() => void send()} />
        </View>
        <Text numberOfLines={2} style={{ color: palette.textTertiary, fontSize: 13, lineHeight: 18 }}>{prTitle}</Text>
        <View style={{ minHeight: 132, borderRadius: 20, borderCurve: 'continuous', borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card, paddingHorizontal: 14, paddingTop: 12 }}>
          <TextInput
            autoFocus
            multiline
            accessibilityLabel={needsBody ? 'Comment' : 'Comment, optional'}
            placeholder={needsBody ? 'Leave a comment…' : 'Add a comment (optional)…'}
            placeholderTextColor={palette.textTertiary}
            value={body}
            onChangeText={setBody}
            style={{ minHeight: 108, color: palette.text, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' }}
          />
        </View>
        {error ? <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: 14 }}>{error}</Text> : null}
      </ScrollView>
    </Modal>
  )
}
