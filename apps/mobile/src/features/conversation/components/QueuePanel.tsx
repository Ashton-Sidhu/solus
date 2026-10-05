import { useReducer, useState } from 'react'
import { Modal, ScrollView, Text, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { isSteerableStatus, type QueuedPromptSnapshot } from '@solus/contracts/types'
import type { SessionQueueMutation } from '@solus/contracts/session-queue'
import { Button, Field } from '../../../ui/primitives'
import { usePalette } from '../../../theme/theme'
import { space, type } from '../../../theme/tokens'
import type { ConversationMeta, ConversationStore } from '../conversation-store'
import { QueueDraft } from '../lib/queue-edit'

export function QueuePanel({ store, meta, onClose }: { store: ConversationStore; meta: ConversationMeta; onClose(): void }) {
  const palette = usePalette()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<QueueDraft | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [, refresh] = useReducer((value: number) => value + 1, 0)
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const change = (mutation: SessionQueueMutation) => run(() => store.controller.changeQueue(mutation))
  const close = () => { setOpen(false); setDraft(null); onClose() }
  const edit = (entry: QueuedPromptSnapshot) => { setDraft(new QueueDraft(entry, store.controller)); setError('') }
  const addFiles = () => run(async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (!result.canceled && draft) {
      await draft.addFiles(result.assets.map((file) => ({ uri: file.uri, name: file.name, mimeType: file.mimeType ?? null, size: file.size ?? null })))
      refresh()
    }
  })
  if (!meta.queue.entries.length && !meta.queue.held && !open) return null
  return <>
    <Button label={`${meta.queue.entries.length} queued${meta.queue.held ? ' · Held' : ''}`} onPress={() => { setOpen(true); void run(() => store.controller.refreshQueue()) }} />
    <Modal visible={open} presentationStyle="pageSheet" animationType="slide" onRequestClose={close}>
      <ScrollView style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={{ color: palette.text, fontSize: type.title }}>Queue</Text>
        {error ? <Text accessibilityRole="alert" style={{ color: palette.danger }}>{error}</Text> : null}
        {draft ? <>
          <Field label="Queued prompt" multiline value={draft.text} onChangeText={(text) => { draft.text = text; refresh() }} />
          {draft.attachments?.map((file) => <View key={file.id}><Text style={{ color: palette.text }}>{file.name}</Text><Button label={`Remove ${file.name}`} disabled={busy} onPress={() => { draft.removeFile(file.id); refresh() }} /></View>)}
          <Button label="Add files" busy={busy} onPress={() => void addFiles()} />
          <Button label="Save" busy={busy} onPress={() => void run(async () => { await draft.save(); setDraft(null) })} />
          <Button label="Cancel edit" disabled={busy} onPress={() => setDraft(null)} />
        </> : meta.queue.entries.map((entry, index, entries) => <View key={entry.queueId} style={{ gap: space.sm }}>
          <Text style={{ color: palette.text, fontSize: type.chrome }}>{index + 1}. {entry.text}</Text>
          <Text style={{ color: palette.textTertiary }}>{entry.provider}{entry.modelConfig?.modelId ? ` · ${entry.modelConfig.modelId}` : ''}{entry.held ? ' · Held' : ''}</Text>
          {entry.error ? <Text style={{ color: palette.danger }}>{entry.error}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
            {entry.kind !== 'provider_switch' ? <><Button label="Edit" disabled={busy} onPress={() => edit(entry)} /><Button label="Steer now" disabled={busy || entry.held || !isSteerableStatus(meta.status)} onPress={() => void change({ kind: 'steer', queueId: entry.queueId, revision: entry.revision ?? 0 })} /></> : null}
            <Button label="Up" disabled={busy || index === 0} onPress={() => void change({ kind: 'move', queueId: entry.queueId, revision: entry.revision ?? 0, beforeQueueId: entries[index - 1]?.queueId ?? null })} />
            <Button label="Down" disabled={busy || index === entries.length - 1} onPress={() => void change({ kind: 'move', queueId: entry.queueId, revision: entry.revision ?? 0, beforeQueueId: entries[index + 2]?.queueId ?? null })} />
            <Button label="Remove" disabled={busy} onPress={() => void change({ kind: 'remove', queueId: entry.queueId, revision: entry.revision ?? 0 })} />
          </View>
        </View>)}
        {meta.queue.held ? <Button label="Resume queue" busy={busy} onPress={() => void change({ kind: 'resume' })} /> : null}
        <Button label="Done" disabled={busy} onPress={close} />
      </ScrollView>
    </Modal>
  </>
}
