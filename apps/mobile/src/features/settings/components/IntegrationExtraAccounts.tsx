import { ActivityIndicator, View } from 'react-native'
import type { Integration, IntegrationConnection } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { AppText as Text } from '../../../components/AppText'
import type { AddingAccount } from '../integrations'
import { SettingsActionRow } from './SettingsActionRow'

/**
 * The person's accounts after the first on one integration
 * (docs/plans/mcp-integrations.md §13.3), and "Add another account". The same
 * capability as the desktop and web integration row. An added account lives on
 * this host; tools that read span every account, and tools that write name one.
 */
export function IntegrationExtraAccounts(props: {
  readonly integration: Integration
  /** The first account: one more is added only beside a connected first one. */
  readonly first: IntegrationConnection | undefined
  readonly accounts: readonly IntegrationConnection[] | undefined
  readonly adding: AddingAccount | undefined
  readonly enabled: boolean
  readonly onAdd: () => void
  readonly onCancelAdd: () => void
  readonly onReopen: () => void
  readonly onDisconnect: (accountId: string) => void
}) {
  const { integration, adding } = props
  const accounts = props.accounts ?? []
  const canAdd = new IntegrationSignIn(integration).acceptsAnotherAccount && props.first?.status === 'connected'
  if (!accounts.length && !canAdd) return null
  return (
    <View>
      {accounts.map((account) => (
        <SettingsActionRow
          key={account.accountId}
          icon="xmark.circle.fill"
          tone="danger"
          label={`Disconnect ${account.label ?? 'another account'}${account.status === 'connected' ? '' : ' (needs sign-in)'}`}
          disabled={!props.enabled}
          onPress={() => props.onDisconnect(account.accountId)}
        />
      ))}
      {adding?.url ? (
        <View className="flex-row items-center gap-2 px-4 py-3 pl-[58px]">
          <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
          <Text className="min-w-0 flex-1 text-sm text-foreground-muted">Finish signing in to the other account in your browser.</Text>
        </View>
      ) : null}
      {adding?.url ? <SettingsActionRow icon="arrow.clockwise" label="Reopen sign-in" onPress={props.onReopen} /> : null}
      {adding?.url ? <SettingsActionRow icon="xmark.circle.fill" label="Cancel adding" onPress={props.onCancelAdd} /> : null}
      {canAdd && !adding?.url ? <SettingsActionRow icon="plus" label="Add another account" disabled={!props.enabled} onPress={props.onAdd} /> : null}
      {adding?.error ? (
        <View className="px-4 pb-3 pl-[58px]">
          <Text className="text-sm text-danger-foreground" accessibilityRole="alert">{adding.error}</Text>
        </View>
      ) : null}
    </View>
  )
}
