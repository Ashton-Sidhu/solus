// Adapted from T3 Code apps/mobile/src/features/review/ReviewCommentComposerSheet.tsx (MIT, see UPSTREAM.md).
import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text, AppTextInput as TextInput } from '../../../components/AppText'
import { ControlPill } from '../../../components/ControlPill'
import { ErrorBanner } from '../../../components/ErrorBanner'

/** What the sheet writes: a conversation comment, or a review with a verdict. */
export type PrComposerIntent =
  | { kind: 'comment' }
  | { kind: 'review'; verdict: 'approve' | 'request-changes' }

const TITLES = {
  comment: 'Add Comment',
  approve: 'Approve',
  'request-changes': 'Request Changes',
} as const

/**
 * T3 Code's comment sheet, without a line target: the phone comments on the
 * pull request as a whole. A comment and a change request need words; an
 * approval may stand alone.
 */
export function PrComposerSheet({ intent, prTitle, onSubmit, onClose }: {
  intent: PrComposerIntent | null
  prTitle: string
  onSubmit: (intent: PrComposerIntent, body: string) => Promise<void>
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
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
  const sendLabel = intent.kind === 'comment' ? 'Comment' : 'Submit'

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
      <View className="flex-1 bg-sheet">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
          <View
            className="flex-1 px-5"
            style={{ paddingTop: Platform.OS === 'android' ? insets.top + 8 : 8 }}
          >
            <View className="flex-row items-center justify-between py-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                className="bg-subtle h-12 w-12 items-center justify-center rounded-full"
                onPress={onClose}
              >
                <SymbolView name="xmark" size={18} tintColorClassName="accent-icon" type="monochrome" />
              </Pressable>
              <Text accessibilityRole="header" className="text-lg font-t3-bold text-foreground">{title}</Text>
              <View className="h-12 w-12" />
            </View>

            <View className="min-h-0 flex-1 gap-4">
              <View className="gap-1 px-1">
                <Text className="text-2xs font-t3-bold uppercase text-foreground-muted">Pull request</Text>
                <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={2}>{prTitle}</Text>
              </View>

              {error ? <ErrorBanner message={error} /> : null}

              <View className="min-h-0 flex-1 gap-2">
                <Text className="text-sm font-t3-bold text-foreground">{needsBody ? 'Comment' : 'Comment (optional)'}</Text>
                <View className="min-h-[132px] flex-1 overflow-hidden rounded-[20px] border border-border bg-card">
                  <View className="min-h-0 flex-1 px-4 pt-3.5">
                    <TextInput
                      autoFocus
                      multiline
                      scrollEnabled
                      accessibilityLabel={needsBody ? 'Comment' : 'Comment, optional'}
                      placeholder={needsBody ? 'Leave a comment...' : 'Add a comment (optional)...'}
                      textAlignVertical="top"
                      value={body}
                      onChangeText={setBody}
                      editable={!busy}
                      className="h-full min-h-0 flex-1 border-0 bg-transparent px-0 py-0 font-sans text-base"
                    />
                  </View>
                </View>
              </View>
            </View>
          </View>
          <View
            className="flex-row items-center gap-3 bg-sheet px-5 py-2"
            style={{ paddingBottom: Math.max(insets.bottom, 10) }}
          >
            <View className="flex-1" />
            <ControlPill
              accessibilityLabel={sendLabel}
              icon="arrow.up"
              label={busy ? 'Sending...' : sendLabel}
              variant="primary"
              disabled={!canSend}
              onPress={() => void send()}
            />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}
