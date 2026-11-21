import { useState } from 'react'
import { View } from 'react-native'
import type { Integration, IntegrationLaunch } from '@solus/contracts/integration-types'
import { commandLineText, type CommandProcessStatus } from '@solus/contracts/integrations/command-server'
import { AppText as Text } from '../../../components/AppText'
import type { useCommandProcesses } from '../use-command-processes'
import { CommandProcessPanel } from './CommandProcessPanel'
import { CommandServerForm } from './CommandServerForm'
import { SettingsActionRow } from './SettingsActionRow'

/**
 * The open row of a command (docs/plans/mcp-first-class.md §7.7): its line and
 * folder, or the form that changes them, its process state with its actions,
 * and Edit command. A person without `host.admin` sees why it cannot change
 * in the process panel, once.
 */
export function CommandServerDetails(props: {
  readonly integration: Integration
  readonly process: CommandProcessStatus
  readonly processes: ReturnType<typeof useCommandProcesses>
  readonly isConnected: boolean
  /** No other change runs, and the person owns the server. */
  readonly isEditable: boolean
  readonly isSaving: boolean
  readonly onEdit: (launch: IntegrationLaunch, envNames: string[] | undefined) => Promise<void>
}) {
  const { integration, processes } = props
  const [isEditing, setEditing] = useState(false)
  return (
    <View>
      <View className="gap-4 px-4 pb-4 pl-[58px]">
        {isEditing ? (
          <CommandServerForm
            hostName="this host"
            mayRunCommands={processes.mayRunCommands}
            editing={integration}
            enabled={props.isConnected && props.isEditable}
            onEdit={async (launch, envNames) => {
              await props.onEdit(launch, envNames)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <View className="gap-1">
            <Text className="font-mono text-sm text-foreground" selectable>{integration.launch ? commandLineText(integration.launch) : ''}</Text>
            <Text className="text-sm text-foreground-muted">{`In ${integration.launch?.cwd ?? '~'} on this host`}</Text>
          </View>
        )}
        <CommandProcessPanel
          status={props.process}
          error={processes.errorOf(integration.id)}
          enabled={props.isConnected}
          onAction={(kind) => processes.run(integration.id, kind)}
        />
      </View>
      {isEditing ? null : (
        <SettingsActionRow icon="terminal" label="Edit command" loading={props.isSaving} disabled={!props.isEditable || !processes.mayRunCommands} onPress={() => setEditing(true)} />
      )}
    </View>
  )
}
