import { useState } from 'react'
import { Alert, Text, View } from 'react-native'
import type { Integration, IntegrationOAuthClientInput } from '@solus/contracts/integration-types'
import { copyTextWithHaptic } from '../../../lib/copyTextWithHaptic'
import { usePalette } from '../../../theme/theme'
import { CODE_FONT, space, type } from '../../../theme/tokens'
import { Button, Field } from '../../../ui/primitives'
import { errorMessage, OAUTH_CALLBACK_PATH, oauthClientText as text } from '../integrations'

/**
 * The administrator's OAuth client for a server with no dynamic registration
 * (docs/plans/mcp-integrations.md §4.3). With no client it explains what to
 * create, shows the redirect path to copy, and takes the client ID and secret.
 * With a client it shows the ID and whether a secret is saved, with Change and
 * Remove. The secret lives only in this form until Save sends it to the host.
 */
export function IntegrationOAuthClientPanel(props: {
  readonly integration: Integration
  /** True while this integration's client is being saved or removed. */
  readonly saving: boolean
  /** False while another change runs or the host is away. */
  readonly enabled: boolean
  readonly onSave: (client: IntegrationOAuthClientInput | null) => Promise<void>
}) {
  const { integration, saving, enabled } = props
  const palette = usePalette()
  const auth = integration.auth.kind === 'oauth' ? integration.auth : null
  const [editing, setEditing] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const note = (value: string) => <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>{value}</Text>
  const heading = <Text style={{ color: palette.text, fontSize: type.chrome, fontWeight: '600' }}>{text.title}</Text>

  const startEditing = () => {
    setClientId(auth?.clientId ?? '')
    setClientSecret('')
    setEditing(true)
  }

  const save = () => {
    const id = clientId.trim()
    if (!id) return
    props.onSave({ clientId: id, ...(clientSecret.trim() ? { clientSecret } : {}) }).then(
      () => {
        setEditing(false)
        setClientSecret('')
      },
      (cause: unknown) => Alert.alert('Not saved', errorMessage(cause)),
    )
  }

  const confirmRemove = () => {
    Alert.alert(text.removeTitle, text.removeDetail, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: text.remove,
        style: 'destructive',
        onPress: () => {
          props.onSave(null).catch((cause: unknown) => Alert.alert('Not removed', errorMessage(cause)))
        },
      },
    ])
  }

  if (auth?.clientId && !editing) {
    return (
      <View style={{ gap: space.sm }}>
        {heading}
        <Text selectable style={{ color: palette.text, fontSize: type.chrome, fontFamily: CODE_FONT }} accessibilityLabel={`${text.clientIdLabel}: ${auth.clientId}`}>{auth.clientId}</Text>
        {note(auth.hasClientSecret ? text.secretSaved : text.noSecret)}
        <Button label={text.change} disabled={!enabled} onPress={startEditing} />
        <Button tone="danger" label={text.remove} busy={saving} disabled={!enabled} onPress={confirmRemove} />
      </View>
    )
  }

  return (
    <View style={{ gap: space.sm }}>
      {heading}
      <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{text.explanation}</Text>
      <View style={{ gap: space.xs }}>
        <Text style={{ color: palette.textTertiary, fontSize: type.dense, fontWeight: '600' }}>{text.redirectLabel}</Text>
        <Text selectable style={{ color: palette.text, fontSize: type.chrome, fontFamily: CODE_FONT }}>{OAUTH_CALLBACK_PATH}</Text>
        {note(text.redirectNote)}
      </View>
      <Button label="Copy" onPress={() => copyTextWithHaptic(OAUTH_CALLBACK_PATH, { target: 'redirect path' })} />
      <Field
        label={text.clientIdLabel}
        value={clientId}
        onChangeText={setClientId}
        editable={!saving}
        returnKeyType="next"
      />
      <Field
        label={text.clientSecretLabel}
        value={clientSecret}
        onChangeText={setClientSecret}
        secureTextEntry
        textContentType="password"
        editable={!saving}
        returnKeyType="done"
        onSubmitEditing={save}
      />
      {note(editing && auth?.hasClientSecret ? text.changeSecretNote : text.clientSecretNote)}
      <Button tone="primary" label={text.save} busy={saving} disabled={!clientId.trim() || !enabled} onPress={save} />
      {editing ? <Button label="Cancel" disabled={saving} onPress={() => { setEditing(false); setClientSecret('') }} /> : null}
    </View>
  )
}
