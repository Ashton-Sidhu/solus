import { Platform, ScrollView, Text } from 'react-native'
import { useListened } from '../../../app/app-context'
import { AppSheet } from '../../../components/AppSheet'
import { usePalette } from '../../../theme/theme'
import { space, type } from '../../../theme/tokens'
import { Banner, Button } from '../../../ui/primitives'
import { IntegrationConnectPanel } from '../../settings/components/IntegrationConnectPanel'
import { IntegrationOAuthClientPanel } from '../../settings/components/IntegrationOAuthClientPanel'
import { useIntegrations } from '../../settings/use-integrations'
import { useSetupHandoff } from '../../settings/use-setup-handoff'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import type { ConversationStore } from '../conversation-store'

/**
 * An integration tool of this session's turn needs the person's own connection
 * (`integration.connectNeeded`, docs/plans/mcp-integrations.md §4.1 rule 2).
 * Connect runs the same flow as the Integrations row, here in the sheet;
 * Dismiss closes it and stops a sign-in still waiting. A server that needs an
 * OAuth client shows the row's client panel first, so its owner enters it here
 * (§13.2); only the owner's list holds the integration, so only they see it.
 * "Set up with an agent" opens a new chat whose prompt finds the key or the
 * client to create (§13.4). Typing is the natural
 * next step after it closes, so focus returns to the composer. T3 has no
 * connect sheet in a thread; this is T3's `AppSheet`, its sheet for local
 * thread context that the owner dismisses. Its Done (or a swipe) dismisses.
 */
export function IntegrationConnectSheet({ store, onClose }: { store: ConversationStore; onClose(): void }) {
  const palette = usePalette()
  const { controller } = store
  const request = useListened(controller.connectNeededChanges, () => controller.connectNeeded)
  const integrations = useIntegrations(controller.hostId)
  const { flows } = integrations
  const handOff = useSetupHandoff(controller.hostId)
  if (!request) return null
  const { integrationId, integrationName } = request
  const flow = flows.flows.get(integrationId)
  const integration = integrations.list.kind === 'loaded' ? integrations.list.integrations.find((item) => item.id === integrationId) : undefined
  const signIn = integration ? new IntegrationSignIn(integration) : null
  const integrationNeedingClient = signIn?.needsOwnerClient ? integration : null
  const connection = integrations.connections.kind === 'loaded' ? integrations.connections.byIntegration.get(integrationId) : undefined
  const setupHandoff = signIn?.setupHandoffFor(connection, { name: integrationName, callbackUrl: integrations.oauthRedirectUrl }) ?? null
  const dismiss = () => {
    void flows.cancel(integrationId)
    controller.dismissConnectNeeded()
    onClose()
  }
  return (
    <AppSheet title={`Connect ${integrationName}`} onClose={dismiss}>
      <ScrollView
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior={Platform.OS === 'ios' ? 'automatic' : 'never'}
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        {!flows.connected ? <Banner tone="info" message="The host is not connected. Connect when it reconnects." /> : null}
        {integrationNeedingClient ? (
          <IntegrationOAuthClientPanel
            integration={integrationNeedingClient}
            redirectUrl={integrations.oauthRedirectUrl}
            saving={integrations.busy === `oauth-client:${integrationId}`}
            enabled={integrations.connected && integrations.busy === null}
            onSave={(client) => integrations.setOAuthClient(integrationId, client)}
          />
        ) : null}
        {flow ? (
          <IntegrationConnectPanel
            key={flow.step}
            flow={flow}
            connected={flows.connected}
            onOpen={() => flows.openSignIn(integrationId)}
            onSubmit={(value) => void flows.submit(integrationId, value)}
            onCancel={() => void flows.cancel(integrationId)}
            onDone={dismiss}
          />
        ) : <>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>
            {`The agent needs your ${integrationName} account to use its tools.`}
          </Text>
          <Button tone="primary" label="Connect" disabled={!flows.connected || !!integrationNeedingClient} onPress={() => void flows.connect({ id: integrationId, name: integrationName })} />
        </>}
        {setupHandoff ? <>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{setupHandoff.hint}</Text>
          <Button
            label="Set up with an agent"
            disabled={!flows.connected}
            onPress={() => {
              dismiss()
              handOff(setupHandoff)
            }}
          />
        </> : null}
        {!flow || flow.step === 'starting' ? <Button label="Dismiss" onPress={dismiss} /> : null}
      </ScrollView>
    </AppSheet>
  )
}
