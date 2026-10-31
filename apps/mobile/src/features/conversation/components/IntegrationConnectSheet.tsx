import { Platform, ScrollView, Text, View } from 'react-native'
import { useListened } from '../../../app/app-context'
import { AppSheet } from '../../../components/AppSheet'
import { usePalette } from '../../../theme/theme'
import { space, type } from '../../../theme/tokens'
import { Banner, Button, Card } from '../../../ui/primitives'
import { IntegrationConnectPanel } from '../../settings/components/IntegrationConnectPanel'
import { IntegrationOAuthClientPanel } from '../../settings/components/IntegrationOAuthClientPanel'
import { useIntegrations } from '../../settings/use-integrations'
import { useSetupHandoff } from '../../settings/use-setup-handoff'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import type { SetupHandoff } from '@solus/contracts/integrations/setup-handoff'
import type { IntegrationConnectNeeded } from '@solus/contracts/integration-types'
import type { ConversationStore } from '../conversation-store'

/**
 * Integration tools of this session's turn need the person's own connection
 * (`integration.connectNeeded`, docs/plans/mcp-integrations.md §4.1 rule 2).
 * One sheet lists every integration the turn asked for, one card each, as the
 * group connect card does on desktop and web. Connect runs the same flow as the
 * Integrations row, here in the card; Dismiss closes the sheet and stops every
 * sign-in still waiting. A server that needs an
 * OAuth client shows the row's client panel first, so its owner enters it here
 * (§13.2); only the owner's list holds the integration, so only they see it.
 * "Set up with an agent" opens a new chat whose prompt finds the key or the
 * client to create (§13.4). Typing is the natural
 * next step after it closes, so focus returns to the composer. T3 has no
 * connect sheet in a thread; this is T3's `AppSheet`, its sheet for local
 * thread context that the owner dismisses. Its Done (or a swipe) dismisses.
 */
export function IntegrationConnectSheet({ store, onClose }: { store: ConversationStore; onClose(): void }) {
  const { controller } = store
  const requests = useListened(controller.connectNeededChanges, () => controller.connectNeeded)
  const integrations = useIntegrations(controller.hostId)
  const { flows } = integrations
  const handOff = useSetupHandoff(controller.hostId)
  if (requests.length === 0) return null
  const isConnected = (integrationId: string) =>
    integrations.connections.kind === 'loaded' && integrations.connections.byIntegration.get(integrationId)?.status === 'connected'
  const allConnected = requests.every((request) => isConnected(request.integrationId))
  const dismiss = () => {
    for (const request of requests) void flows.cancel(request.integrationId)
    controller.dismissConnectNeeded()
    onClose()
  }
  const title = requests.length === 1 ? `Connect ${requests[0].integrationName}` : `Connect ${requests.length} services`
  return (
    <AppSheet title={title} onClose={dismiss}>
      <ScrollView
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior={Platform.OS === 'ios' ? 'automatic' : 'never'}
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        {!flows.connected ? <Banner tone="info" message="The host is not connected. Connect when it reconnects." /> : null}
        {requests.map((request) => (
          <IntegrationConnectRow
            key={request.integrationId}
            request={request}
            integrations={integrations}
            isConnected={isConnected(request.integrationId)}
            onDone={requests.length === 1 ? dismiss : () => void flows.cancel(request.integrationId)}
            onHandOff={(setupHandoff) => {
              dismiss()
              handOff(setupHandoff)
            }}
          />
        ))}
        <Button label={allConnected ? 'Done' : 'Dismiss'} onPress={dismiss} />
      </ScrollView>
    </AppSheet>
  )
}

/** One integration of the sheet: its name and state, then the step it is on. */
function IntegrationConnectRow({ request, integrations, isConnected, onDone, onHandOff }: {
  request: IntegrationConnectNeeded
  integrations: ReturnType<typeof useIntegrations>
  isConnected: boolean
  onDone(): void
  onHandOff(setupHandoff: SetupHandoff): void
}) {
  const palette = usePalette()
  const { flows } = integrations
  const { integrationId, integrationName } = request
  const flow = flows.flows.get(integrationId)
  const integration = integrations.list.kind === 'loaded' ? integrations.list.integrations.find((item) => item.id === integrationId) : undefined
  const signIn = integration ? new IntegrationSignIn(integration) : null
  const integrationNeedingClient = signIn?.needsOwnerClient ? integration : null
  const connection = integrations.connections.kind === 'loaded' ? integrations.connections.byIntegration.get(integrationId) : undefined
  const setupHandoff = signIn?.setupHandoffFor(connection, { name: integrationName, callbackUrl: integrations.oauthRedirectUrl }) ?? null
  const settled = isConnected && !flow
  return (
    <Card>
      <View style={{ gap: 2 }}>
        <Text numberOfLines={1} style={{ color: palette.text, fontSize: type.chrome, fontWeight: '500' }}>{integrationName}</Text>
        <Text numberOfLines={1} style={{ color: settled ? palette.textSecondary : palette.textTertiary, fontSize: type.dense }}>
          {settled ? 'Connected' : 'Needed to use its tools.'}
        </Text>
      </View>
      {settled ? null : <>
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
            onDone={onDone}
          />
        ) : (
          <Button tone="primary" label="Connect" disabled={!flows.connected || !!integrationNeedingClient} onPress={() => void flows.connect({ id: integrationId, name: integrationName })} />
        )}
        {setupHandoff ? <>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{setupHandoff.hint}</Text>
          <Button label="Set up with an agent" disabled={!flows.connected} onPress={() => onHandOff(setupHandoff)} />
        </> : null}
      </>}
    </Card>
  )
}
