import { forwardRef, useEffect, useRef, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { isSessionBusyStatus } from '@solus/contracts/types'
import { useApp } from '../../../app/app-context'
import { usePalette } from '../../../theme/theme'
import { radius, space, TOUCH_TARGET, type } from '../../../theme/tokens'
import { useKeyboardCommand } from '../../keyboard/use-keyboard-command'
import type { ConversationMeta, ConversationStore } from '../conversation-store'
import { AttachButton } from './AttachmentBar'

const DRAFT_SAVE_DELAY_MS = 400

/**
 * The prompt input. Its draft is kept on the device until the host takes the
 * prompt, so a rotation, a split resize, or a restart does not lose it. After
 * sending, focus stays here: typing the next prompt is the natural next step.
 */
export const Composer = forwardRef<TextInput, { store: ConversationStore; conversationId: string; meta: ConversationMeta; disabled: boolean }>(
  function Composer({ store, conversationId, meta, disabled }, ref) {
    const app = useApp()
    const palette = usePalette()
    const hostId = store.controller.hostId
    const [text, setText] = useState(() => app.draft(hostId, conversationId))
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const busy = isSessionBusyStatus(meta.status)
    const hasAttachments = meta.attachments.length > 0

    useEffect(() => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }, [])

    const change = (value: string) => {
      setText(value)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => app.saveDraft(hostId, conversationId, value), DRAFT_SAVE_DELAY_MS)
    }

    const send = () => {
      const prompt = text.trim()
      if (!prompt && !hasAttachments) return
      setText('')
      if (saveTimer.current) clearTimeout(saveTimer.current)
      void store.controller.send(prompt).then(() => app.saveDraft(hostId, conversationId, ''))
    }

    // A send waits for uploads, so the prompt names every file it carries.
    const canSend = (!!text.trim() || hasAttachments) && meta.uploading === 0 && !disabled
    useKeyboardCommand('send', () => { if (canSend) send() })
    useKeyboardCommand('focusInput', () => { if (ref && 'current' in ref) ref.current?.focus() })
    return (
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: palette.border, backgroundColor: palette.surface }}>
        <AttachButton store={store} meta={meta} disabled={disabled} />
        <TextInput
          ref={ref}
          accessibilityLabel="Message"
          accessibilityHint={busy ? 'Sending now steers the running turn' : undefined}
          placeholder={busy ? 'Steer the agent…' : 'Message the agent'}
          placeholderTextColor={palette.textTertiary}
          value={text}
          onChangeText={change}
          multiline
          editable={!disabled}
          style={{ flex: 1, minHeight: TOUCH_TARGET, maxHeight: 180, borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card, color: palette.text, fontSize: type.body, paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11 }}
        />
        {busy && !text.trim() && !hasAttachments ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop the agent" onPress={() => void store.controller.stop()} style={{ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.dangerSoft, paddingHorizontal: space.md }}>
            <Text style={{ color: palette.danger, fontSize: type.chrome, fontWeight: '600' }}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }} disabled={!canSend} onPress={send} style={{ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? palette.accent : palette.card, paddingHorizontal: space.md }}>
            <Text style={{ color: canSend ? palette.onAccent : palette.textTertiary, fontSize: type.chrome, fontWeight: '600' }}>Send</Text>
          </Pressable>
        )}
      </View>
    )
  },
)
