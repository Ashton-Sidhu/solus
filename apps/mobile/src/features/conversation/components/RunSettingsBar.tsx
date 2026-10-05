import { useState, type ReactNode } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { type ReasoningEffort } from '@solus/contracts/types'
import { usePalette } from '../../../theme/theme'
import { radius, space, TOUCH_TARGET, type } from '../../../theme/tokens'
import { Button } from '../../../ui/primitives'
import type { ConversationMeta, ConversationStore } from '../conversation-store'
import { effortChoices, effortLabel, modelChoices, modelLabel, PERMISSION_MODE_TEXT, PERMISSION_MODES } from '../lib/run-settings'

/**
 * What the next prompt runs with. The current turn keeps its options.
 */
export function RunSettingsBar({ store, meta, onClose }: { store: ConversationStore; meta: ConversationMeta; onClose(): void }) {
  const palette = usePalette()
  const [open, setOpen] = useState(false)
  const close = () => { setOpen(false); onClose() }
  const { run } = meta
  const [error, setError] = useState('')
  const summary = `${modelLabel(run.provider, run.model)} · ${effortLabel(run.reasoningEffort)} · ${PERMISSION_MODE_TEXT[run.permissionMode].label}`
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Run settings: ${summary}`}
        accessibilityHint="Changes apply to the next message"
        onPress={() => setOpen(true)}
        style={{ paddingHorizontal: space.lg, paddingVertical: space.xs, minHeight: 32, justifyContent: 'center' }}
      >
        <Text numberOfLines={1} style={{ color: palette.textTertiary, fontSize: type.dense }}>{summary}</Text>
      </Pressable>
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        <ScrollView style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
          <Text accessibilityRole="header" style={{ color: palette.text, fontSize: type.title, fontWeight: '600' }}>Run settings</Text>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>
            Changes apply to the next message. Provider switches wait in queue order.
          </Text>
          {error ? <Text accessibilityRole="alert" style={{ color: palette.danger }}>{error}</Text> : null}
          <Section title="Provider">
            {(['claude-code', 'codex'] as const).map((provider) => <Choice key={provider} label={provider === 'codex' ? 'Codex' : 'Claude Code'} selected={run.provider === provider}
              onPress={() => { setError(''); void store.controller.switchProvider(provider).catch((failure: Error) => setError(failure.message)) }} />)}
          </Section>
          <Section title="Model">
            {modelChoices(run.provider, run.model).map((choice) => (
              <Choice key={choice.id} label={choice.label} selected={choice.id === run.model} onPress={() => store.controller.updateRun({ model: choice.id })} />
            ))}
          </Section>
          <Section title="Effort">
            {effortChoices(run.provider, run.model).map((effort: ReasoningEffort) => (
              <Choice key={effort} label={effortLabel(effort)} selected={effort === run.reasoningEffort} onPress={() => store.controller.updateRun({ reasoningEffort: effort })} />
            ))}
          </Section>
          <Section title="Permissions">
            {PERMISSION_MODES.map((mode) => (
              <Choice key={mode} label={PERMISSION_MODE_TEXT[mode].label} detail={PERMISSION_MODE_TEXT[mode].description} selected={mode === run.permissionMode} onPress={() => store.controller.updateRun({ permissionMode: mode })} />
            ))}
          </Section>
          <Button tone="primary" label="Done" onPress={close} />
        </ScrollView>
      </Modal>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const palette = usePalette()
  return (
    <View style={{ gap: space.xs }}>
      <Text accessibilityRole="header" style={{ color: palette.textTertiary, fontSize: type.dense, fontWeight: '600' }}>{title}</Text>
      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card, overflow: 'hidden' }}>{children}</View>
    </View>
  )
}

function Choice({ label, detail, selected, disabled, onPress }: { label: string; detail?: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const palette = usePalette()
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: TOUCH_TARGET, paddingHorizontal: space.md, paddingVertical: space.sm, justifyContent: 'center', backgroundColor: pressed ? palette.accentSoft : 'transparent', opacity: disabled ? 0.5 : 1, borderBottomWidth: 1, borderBottomColor: palette.border })}
    >
      <Text style={{ color: selected ? palette.accent : palette.text, fontSize: type.chrome, fontWeight: selected ? '600' : '400' }}>{selected ? '✓ ' : ''}{label}</Text>
      {detail ? <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>{detail}</Text> : null}
    </Pressable>
  )
}
