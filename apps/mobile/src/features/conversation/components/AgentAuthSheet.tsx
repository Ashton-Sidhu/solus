import { useState, type ReactNode } from 'react'
import { ActivityIndicator, Modal, ScrollView, Text, View } from 'react-native'
import { signInLead, signInSteps, type SignInCodeFlow, type SignInPhase, type SignInStep } from '@solus/client-core/sign-in-steps'
import { useApp, useListened } from '../../../app/app-context'
import { usePalette } from '../../../theme/theme'
import { CODE_FONT, radius, space, type } from '../../../theme/tokens'
import { Banner, Button, Field } from '../../../ui/primitives'
import { copyTextWithHaptic } from '../../../lib/copyTextWithHaptic'
import type { AgentAuthView } from '../agent-auth-flow'
import type { ConversationStore } from '../conversation-store'

/**
 * The sign-in a `/login`, `/design-login`, or `/mcp login` command started, or a
 * turn whose login the provider refused:
 * open the page, show the device code, hand back what the host asks for.
 * A sign-in that moves a code across reads as the same two plain steps as the
 * desktop and web card, with the current step outlined in the accent.
 * Typing is the natural next step after it closes, so focus returns to the composer.
 */
export function AgentAuthSheet({ store, onClose }: { store: ConversationStore; onClose(): void }) {
  const app = useApp()
  const palette = usePalette()
  const auth = store.controller.auth
  const view = useListened(auth.changes, auth.snapshot)
  const connected = useListened(app.connections.changes, () => app.connections.state(store.controller.hostId)?.phase === 'connected')
  /** A Solus Cloud host runs on the account's agent connections, so a refused login is fixed there, not on the host. */
  const cloudConnectionsUrl = useListened(app.account.changes, () => {
    const account = app.account.view
    return app.registry.host(store.controller.hostId)?.uplink?.kind === 'managed' && account.kind === 'signed-in' ? `${account.origin}/connections` : null
  })
  const [value, setValue] = useState('')
  const [openError, setOpenError] = useState('')
  /** The sign-in page this sheet opened. The phone never opens it on its own. */
  const [openedUrl, setOpenedUrl] = useState<string | null>(null)
  const open = (url: string) => {
    setOpenError('')
    setOpenedUrl(url)
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
            <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>Getting your sign-in ready…</Text>
          </View>
        ) : null}
        {view.step === 'waiting' && movesCode(view) ? (
          <CodeSignIn view={view} value={value} setValue={setValue} opened={openedUrl === view.url} open={open} connected={connected} submit={() => void auth.submit(value)} cancel={cancel} />
        ) : null}
        {/* A sign-in the page finishes, or that hands back an address only when the page fails to load. */}
        {view.step === 'waiting' && !movesCode(view) ? <>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>Sign in on the page. Solus finishes when the host confirms it.</Text>
          <Button tone="primary" label="Open sign-in page" onPress={() => open(view.url)} />
          {view.input ? <>
            <Field
              label="Paste the address your browser ended on"
              value={value}
              onChangeText={setValue}
              editable={!view.busy}
              returnKeyType="send"
              onSubmitEditing={() => void auth.submit(value)}
            />
            <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>Only needed when the page fails to load after you sign in. Copy its address from the browser and paste it here.</Text>
            <Button label="Submit" busy={view.busy} disabled={!value.trim() || !connected} onPress={() => void auth.submit(value)} />
          </> : null}
          {view.submitted ? <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>Sent. Waiting for the host to finish the sign-in…</Text> : null}
          {view.error ? <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: type.chrome }}>{view.error}</Text> : null}
          <Button label="Cancel" disabled={view.busy} onPress={cancel} />
        </> : null}
        {view.step === 'refused' ? <>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{view.label} refused the login for this turn. Sign in again, then retry from your message.</Text>
          {cloudConnectionsUrl
            ? <Button tone="primary" label="Open cloud connections" onPress={() => open(cloudConnectionsUrl)} />
            : <Button tone="primary" label="Sign in again" disabled={!connected} onPress={() => void auth.run({ kind: 'login', provider: view.provider }, store.controller.run.workingDirectory)} />}
        </> : null}
        {view.step === 'finished' ? <>
          <Banner tone={view.ok ? 'info' : 'error'} message={view.message} />
          {view.url ? <Button tone="primary" label="Open sign-in page" onPress={() => open(view.url ?? '')} /> : null}
        </> : null}
        {openError ? <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: type.chrome }}>{openError}</Text> : null}
        {view.step !== 'waiting' ? <Button tone={view.step === 'finished' ? 'primary' : 'secondary'} label={view.step === 'finished' ? 'Done' : view.step === 'refused' ? 'Not now' : 'Close'} onPress={done} /> : null}
      </ScrollView>
    </Modal>
  )
}

type WaitingView = Extract<AgentAuthView, { step: 'waiting' }>

/** Claude's and Codex's sign-ins move a code across; the other sign-ins finish on the page. */
function movesCode(view: WaitingView): boolean {
  return view.input === 'code' || !!view.userCode
}

function codeFlowOf(view: WaitingView): SignInCodeFlow {
  return view.input === 'code' ? 'paste' : 'enter'
}

function signInPhase(view: WaitingView, opened: boolean): SignInPhase {
  if (!opened) return 'start'
  return view.busy || view.submitted ? 'checking' : 'code'
}

/** A sign-in that moves a code across: the two plain steps, the current one outlined. */
function CodeSignIn({ view, value, setValue, opened, open, connected, submit, cancel }: {
  view: WaitingView
  value: string
  setValue(value: string): void
  /** The person opened the sign-in page from this sheet. */
  opened: boolean
  open(url: string): void
  connected: boolean
  submit(): void
  cancel(): void
}) {
  const palette = usePalette()
  const flow = codeFlowOf(view)
  const steps = signInSteps(view.label, flow, signInPhase(view, opened))
  const asksForCode = opened && flow === 'paste' && !view.submitted
  return (
    <>
      {opened ? null : <Text style={{ color: palette.text, fontSize: type.chrome }}>{signInLead(view.label, flow)}</Text>}
      <View style={{ gap: space.xs, marginHorizontal: -space.sm }}>
        <SignInStepRow step={steps[0]} index={1} />
        <SignInStepRow step={steps[1]} index={2}>
          {opened ? <CodeStepBody view={view} flow={flow} value={value} setValue={setValue} submit={submit} /> : null}
        </SignInStepRow>
      </View>
      {view.error ? <>
        <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: type.chrome }}>{view.error}</Text>
        <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>A code works once and expires after a few minutes. Open {view.label} again to get a fresh one.</Text>
      </> : null}
      {opened ? null : <Button tone="primary" label={`Open ${view.label}`} onPress={() => open(view.url)} />}
      {asksForCode ? <Button tone="primary" label={view.busy ? 'Checking…' : 'Continue'} busy={view.busy} disabled={!value.trim() || !connected} onPress={submit} /> : null}
      {opened ? <Button tone="plain" label={`Open ${view.label} again`} onPress={() => open(view.url)} /> : null}
      <Button label="Cancel" disabled={view.busy} onPress={cancel} />
    </>
  )
}

/** What the current second step holds: the code to enter, the field to paste into, or the wait after a paste. */
function CodeStepBody({ view, flow, value, setValue, submit }: {
  view: WaitingView
  flow: SignInCodeFlow
  value: string
  setValue(value: string): void
  submit(): void
}) {
  const palette = usePalette()
  if (flow === 'paste' && !view.submitted) {
    return (
      <Field
        label="Your code"
        placeholder="Paste your code here"
        value={value}
        onChangeText={setValue}
        editable={!view.busy}
        autoFocus
        returnKeyType="send"
        onSubmitEditing={submit}
      />
    )
  }
  const code = view.userCode ?? ''
  return (
    <>
      {flow === 'enter' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Text selectable accessibilityLabel={`Code ${code}`} style={{ color: palette.text, fontSize: type.heading, fontFamily: CODE_FONT, letterSpacing: 2 }}>{code}</Text>
          <Button tone="plain" label="Copy" onPress={() => void copyTextWithHaptic(code, { target: 'sign-in-code' })} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <ActivityIndicator size="small" />
        <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>{view.submitted ? 'Finishing your sign-in…' : `Waiting for ${view.label}…`}</Text>
      </View>
    </>
  )
}

/** One step: a number, or a check once done, and the current step outlined in the accent. */
function SignInStepRow({ step, index, children }: { step: SignInStep; index: number; children?: ReactNode }) {
  const palette = usePalette()
  const current = step.state === 'current'
  return (
    <View
      accessibilityState={{ selected: current }}
      style={{
        flexDirection: 'row',
        gap: space.md,
        padding: space.sm,
        borderRadius: radius.md,
        borderWidth: 1,
        // 45% of the accent, the same outline the desktop and web step takes.
        borderColor: current ? `${palette.accent}73` : 'transparent',
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: current ? palette.accent : palette.card,
          borderWidth: current ? 0 : 1,
          borderColor: palette.border,
        }}
      >
        <Text style={{ color: current ? palette.onAccent : palette.textTertiary, fontSize: type.dense, fontWeight: '600' }}>
          {step.state === 'done' ? '✓' : index}
        </Text>
      </View>
      <View style={{ flex: 1, gap: space.sm }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: current ? palette.text : palette.textTertiary, fontSize: type.chrome, fontWeight: '500' }}>{step.title}</Text>
          {step.hint ? <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>{step.hint}</Text> : null}
        </View>
        {current ? children : null}
      </View>
    </View>
  )
}
