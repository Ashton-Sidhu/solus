import { Linking } from 'react-native'
import { SetupHandoff, type IntegrationSetupNeed, type IntegrationSetupTarget } from '@solus/contracts/integrations/setup-handoff'
import { useSetupHandoff } from '../use-setup-handoff'
import { SettingsActionRow } from './SettingsActionRow'

/**
 * "Set up with an agent" (docs/plans/mcp-integrations.md §13.4) as a row of
 * the MCP screen: shown only while the server needs setup an agent can look
 * up, and the same action as the desktop and web connect dialog.
 */
export function SetupHandoffRow(props: {
  readonly hostId: string
  readonly need: IntegrationSetupNeed | null | undefined
  readonly target: IntegrationSetupTarget
  readonly enabled: boolean
}) {
  const handOff = useSetupHandoff(props.hostId)
  const { need } = props
  if (!need) return null
  return (
    <SettingsActionRow
      icon={{ ios: 'sparkles', android: 'auto_awesome' }}
      label="Set up with an agent"
      disabled={!props.enabled}
      onPress={() => handOff(new SetupHandoff(need, props.target))}
    />
  )
}

/** The vendor's own setup page for a Solus catalog entry (`authHelp`, §13.5); nothing when the entry names none. */
export function SetupGuideRow(props: { readonly name: string; readonly url: string | undefined }) {
  const { url } = props
  if (!url) return null
  return <SettingsActionRow icon="safari" label={`${props.name} setup guide`} onPress={() => void Linking.openURL(url)} />
}
