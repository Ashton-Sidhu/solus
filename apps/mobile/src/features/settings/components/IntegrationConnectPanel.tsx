import { useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { usePalette } from '../../../theme/theme'
import { space, type } from '../../../theme/tokens'
import { Banner, Button, Field } from '../../../ui/primitives'
import type { ConnectFlowState } from '../integrations'

/**
 * One integration sign-in in progress (docs/plans/mcp-integrations.md §4.3),
 * shared by the Integrations row and the conversation's connect sheet. A
 * waiting flow opens its page only when the person taps Open sign-in; a phone's
 * browser usually cannot reach the host, so the host asks for the address the
 * browser ended on. A key flow takes the key in a masked field.
 */
export function IntegrationConnectPanel(props: {
  readonly flow: ConnectFlowState
  readonly connected: boolean
  readonly onOpen: () => void
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
  readonly onDone: () => void
}) {
  const { flow, connected } = props
  const palette = usePalette()
  const [value, setValue] = useState('')
  const submit = () => props.onSubmit(value)
  const note = (text: string) => <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{text}</Text>
  const error = (flow.step === 'waiting' || flow.step === 'token') && flow.error
    ? <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: type.chrome }}>{flow.error}</Text>
    : null

  if (flow.step === 'starting') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <ActivityIndicator />
        {note('Getting your sign-in ready…')}
      </View>
    )
  }
  if (flow.step === 'finished') {
    return (
      <View style={{ gap: space.sm }}>
        <Banner tone={flow.ok ? 'info' : 'error'} message={flow.message} />
        <Button tone="primary" label="Done" onPress={props.onDone} />
      </View>
    )
  }
  if (flow.step === 'token') {
    return (
      <View style={{ gap: space.sm }}>
        <Field
          label="API key"
          placeholder="Paste your API key"
          value={value}
          onChangeText={setValue}
          secureTextEntry
          textContentType="password"
          editable={!flow.busy}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
        />
        <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>The key stays on the host. Agents never see it.</Text>
        {error}
        <Button tone="primary" label="Save" busy={flow.busy} disabled={!value.trim() || !connected} onPress={submit} />
        <Button label="Cancel" disabled={flow.busy} onPress={props.onCancel} />
      </View>
    )
  }
  return (
    <View style={{ gap: space.sm }}>
      {note('Sign in on the page. Solus finishes when the host confirms it.')}
      <Button tone="primary" label="Open sign-in" onPress={props.onOpen} />
      {flow.input === 'redirect-url' && !flow.submitted ? <>
        <Field
          label="Paste the address your browser ended on"
          value={value}
          onChangeText={setValue}
          editable={!flow.busy}
          keyboardType="url"
          returnKeyType="send"
          onSubmitEditing={submit}
        />
        <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>After you sign in, the page may fail to load. Copy its address from the browser and paste it here.</Text>
        <Button label="Submit" busy={flow.busy} disabled={!value.trim() || !connected} onPress={submit} />
      </> : null}
      {flow.submitted ? note('Sent. Waiting for the host to finish the sign-in…') : null}
      {error}
      <Button label="Cancel" disabled={flow.busy} onPress={props.onCancel} />
    </View>
  )
}
