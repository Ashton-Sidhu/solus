import { useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { usePalette } from '../../../theme/theme'
import { space, type } from '../../../theme/tokens'
import type { IntegrationEnvValue } from '@solus/contracts/integration-types'
import { Banner, Button, Field } from '../../../ui/primitives'
import type { ConnectFlowState } from '../integrations'
import { CommandValueFields } from './CommandValueFields'

/**
 * One integration sign-in in progress (docs/plans/mcp-integrations.md §4.3),
 * shared by the Integrations row and the conversation's connect sheet. A
 * waiting flow opens its page only when the person taps Open sign-in; a phone's
 * browser usually cannot reach the host, so the host asks for the address the
 * browser ended on. A key flow takes the key in a masked field. A flow run at
 * Solus Cloud (plans/020 §5.3) says so, and needs no address pasted. A
 * command takes its environment values (docs/plans/mcp-first-class.md §7.7):
 * one masked field for each name, cleared when Save sends them.
 */
export function IntegrationConnectPanel(props: {
  readonly flow: ConnectFlowState
  readonly connected: boolean
  readonly onOpen: () => void
  readonly onSubmit: (value: string) => void
  readonly onSubmitValues: (values: IntegrationEnvValue[]) => void
  readonly onCancel: () => void
  readonly onDone: () => void
}) {
  const { flow, connected } = props
  const palette = usePalette()
  const [value, setValue] = useState('')
  const [values, setValues] = useState<ReadonlyMap<string, string>>(new Map())
  const submit = () => props.onSubmit(value)
  const note = (text: string) => <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{text}</Text>
  const error = (flow.step === 'waiting' || flow.step === 'token' || flow.step === 'values') && flow.error
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
  if (flow.step === 'values') {
    const saveValues = () => {
      const typed = flow.names.map((name) => ({ name, value: values.get(name) ?? '' }))
      // The values leave this panel in the call that saves them.
      setValues(new Map())
      props.onSubmitValues(typed)
    }
    return (
      <View style={{ gap: space.sm }}>
        <CommandValueFields names={flow.names} values={values} onChange={setValues} editable={!flow.busy} autoFocus />
        <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>The values stay on this host for you alone. Agents never see them, and Solus never shows them again.</Text>
        {error}
        <Button tone="primary" label="Save values" busy={flow.busy} disabled={!connected} onPress={saveValues} />
        <Button label="Cancel" disabled={flow.busy} onPress={props.onCancel} />
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
        <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>{flow.through === 'cloud' ? 'The key is kept in your account and used by every host. Agents never see it.' : 'The key stays on the host. Agents never see it.'}</Text>
        {error}
        <Button tone="primary" label="Save" busy={flow.busy} disabled={!value.trim() || !connected} onPress={submit} />
        <Button label="Cancel" disabled={flow.busy} onPress={props.onCancel} />
      </View>
    )
  }
  return (
    <View style={{ gap: space.sm }}>
      {note(flow.through === 'cloud' ? 'Sign in on the page. Solus finishes when Solus Cloud confirms it.' : 'Sign in on the page. Solus finishes when the host confirms it.')}
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
      {flow.submitted ? note('Sent. Waiting for the host to finish the sign-in…') : flow.through === 'cloud' ? note('Waiting for Solus Cloud to finish the sign-in…') : null}
      {error}
      <Button label="Cancel" disabled={flow.busy} onPress={props.onCancel} />
    </View>
  )
}
