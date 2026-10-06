import { useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, Text, View } from 'react-native'
import { useApp, useListened } from '../../../app/app-context'
import { usePalette } from '../../../theme/theme'
import { CODE_FONT, radius, space, type } from '../../../theme/tokens'
import { Banner, Button, Field } from '../../../ui/primitives'
import type { ConversationStore } from '../conversation-store'

/**
 * The sign-in a `/login`, `/design-login`, or `/mcp login` command started:
 * open the page, show the device code, hand back what the host asks for.
 * Typing is the natural next step after it closes, so focus returns to the composer.
 */
export function AgentAuthSheet({ store, onClose }: { store: ConversationStore; onClose(): void }) {
  const app = useApp()
  const palette = usePalette()
  const auth = store.controller.auth
  const view = useListened(auth.changes, auth.snapshot)
  const connected = useListened(app.connections.changes, () => app.connections.state(store.controller.hostId)?.phase === 'connected')
  const [value, setValue] = useState('')
  const [openError, setOpenError] = useState('')
  const open = (url: string) => {
    setOpenError('')
    app.platform.openBrowser(url).catch((error: unknown) => setOpenError(error instanceof Error ? error.message : String(error)))
  }
  const done = () => {
    auth.dismiss()
    setValue('')
    onClose()
  }
  const cancel = () => void auth.cancel().then(() => {
    if (auth.view.step === 'closed') {
      setValue('')
      onClose()
    }
  })
  if (view.step === 'closed') return null
  return (
    <Modal visible presentationStyle="pageSheet" animationType="slide" onRequestClose={view.step === 'waiting' ? cancel : done}>
      <ScrollView style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={{ color: palette.text, fontSize: type.title, fontWeight: '600' }}>{view.title}</Text>
        {!connected ? <Banner tone="info" message="The host is not connected. The sign-in continues when it reconnects." /> : null}
        {view.step === 'starting' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <ActivityIndicator />
            <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>Starting the sign-in on the host…</Text>
          </View>
        ) : null}
        {view.step === 'waiting' ? <>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>
            {view.input === 'code' ? 'Sign in on the page, then paste the code it shows.' : 'Sign in on the page. Solus finishes when the host confirms it.'}
          </Text>
          <Button tone="primary" label="Open sign-in page" onPress={() => open(view.url)} />
          {view.userCode ? (
            <View style={{ gap: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card, padding: space.md }}>
              <Text style={{ color: palette.textTertiary, fontSize: type.dense, fontWeight: '600' }}>Enter this code on the page</Text>
              <Text selectable accessibilityLabel={`Code ${view.userCode}`} style={{ color: palette.text, fontSize: type.heading, fontFamily: CODE_FONT }}>{view.userCode}</Text>
            </View>
          ) : null}
          {view.input ? <>
            <Field
              label={view.input === 'code' ? 'Code from the sign-in page' : 'Paste the address your browser ended on'}
              value={value}
              onChangeText={setValue}
              editable={!view.busy}
              returnKeyType="send"
              onSubmitEditing={() => void auth.submit(value)}
            />
            {view.input === 'redirect-url' ? (
              <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>Only needed when the page fails to load after you sign in. Copy its address from the browser and paste it here.</Text>
            ) : null}
            <Button label="Submit" busy={view.busy} disabled={!value.trim() || !connected} onPress={() => void auth.submit(value)} />
          </> : null}
          {view.submitted ? <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>Sent. Waiting for the host to finish the sign-in…</Text> : null}
          {view.error ? <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: type.chrome }}>{view.error}</Text> : null}
          <Button label="Cancel" disabled={view.busy} onPress={cancel} />
        </> : null}
        {view.step === 'finished' ? <>
          <Banner tone={view.ok ? 'info' : 'error'} message={view.message} />
          {view.url ? <Button tone="primary" label="Open sign-in page" onPress={() => open(view.url ?? '')} /> : null}
        </> : null}
        {openError ? <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: type.chrome }}>{openError}</Text> : null}
        {view.step !== 'waiting' ? <Button tone={view.step === 'finished' ? 'primary' : 'secondary'} label={view.step === 'finished' ? 'Done' : 'Close'} onPress={done} /> : null}
      </ScrollView>
    </Modal>
  )
}
