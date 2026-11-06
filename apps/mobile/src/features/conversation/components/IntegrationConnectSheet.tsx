import { useState } from 'react'
import { Platform, ScrollView, Text, View } from 'react-native'
import { useListened } from '../../../app/app-context'
import { AppSheet } from '../../../components/AppSheet'
import { usePalette } from '../../../theme/theme'
import { space, type } from '../../../theme/tokens'
import { Banner, Button, Card, Field } from '../../../ui/primitives'
import { IntegrationConnectPanel } from '../../settings/components/IntegrationConnectPanel'
import { IntegrationOAuthClientPanel } from '../../settings/components/IntegrationOAuthClientPanel'
import { useIntegrations } from '../../settings/use-integrations'
import { useSetupHandoff } from '../../settings/use-setup-handoff'
import { customCandidate } from '../../settings/integrations'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { SetupHandoff } from '@solus/contracts/integrations/setup-handoff'
import { integrationUrlSchema, type IntegrationConnectNeeded, type IntegrationCustomServerNeeded } from '@solus/contracts/integration-types'
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
 * client to create (§13.4). A server that is not in the catalog
 * (`integration.customServerNeeded`) first shows a card with its address. Typing is the natural
 * next step after it closes, so focus returns to the composer. T3 has no
 * connect sheet in a thread; this is T3's `AppSheet`, its sheet for local
 * thread context that the owner dismisses. Its Done (or a swipe) dismisses.
 */
export function IntegrationConnectSheet({ store, onClose }: { store: ConversationStore; onClose(): void }) {
  const { controller } = store
  const requests = useListened(controller.connectNeededChanges, () => controller.connectNeeded)
  const customServer = useListened(controller.connectNeededChanges, () => controller.customServerNeeded)
  const integrations = useIntegrations(controller.hostId)
  const { flows } = integrations
  const handOff = useSetupHandoff(controller.hostId)
  if (requests.length === 0 && !customServer) return null
  // A server with no sign-in has no connection record, so its auth is the answer.
  const isConnected = (integrationId: string) =>
    (integrations.list.kind === 'loaded' && integrations.list.integrations.find((item) => item.id === integrationId)?.auth.kind === 'none') ||
    (integrations.connections.kind === 'loaded' && integrations.connections.byIntegration.get(integrationId)?.status === 'connected')
  const allConnected = !customServer && requests.every((request) => isConnected(request.integrationId))
  const dismiss = () => {
    for (const request of requests) void flows.cancel(request.integrationId)
    controller.dismissConnectNeeded()
    onClose()
  }
  const count = requests.length + (customServer ? 1 : 0)
  const title = count > 1 ? `Connect ${count} services` : customServer ? 'Add an MCP server' : `Connect ${requests[0].integrationName}`
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
        {customServer ? (
          <CustomServerRow
            request={customServer}
            integrations={integrations}
            onAdded={(integration) => controller.customServerAdded(integration)}
            onHandOff={(setupHandoff) => {
              dismiss()
              handOff(setupHandoff)
            }}
          />
        ) : null}
        <Button label={allConnected ? 'Done' : 'Dismiss'} onPress={dismiss} />
      </ScrollView>
    </AppSheet>
  )
}

/** A server that is not in the catalog: the person enters its address, then it is a row of the sheet. */
function CustomServerRow({ request, integrations, onAdded, onHandOff }: {
  request: IntegrationCustomServerNeeded
  integrations: ReturnType<typeof useIntegrations>
  onAdded(integration: { id: string; name: string }): void
  onHandOff(setupHandoff: SetupHandoff): void
}) {
  const palette = usePalette()
  const [address, setAddress] = useState(request.url ?? '')
  const candidate = customCandidate(address)
  const name = request.name ?? candidate.name
  const isValid = integrationUrlSchema.safeParse(candidate.url).success
  const { adding } = integrations
  const current = adding?.url === candidate.url ? adding : null
  const failure = current?.step === 'failed' ? current : null
  const setupHandoff = failure?.setupNeed
    ? new SetupHandoff(failure.setupNeed, { name, url: candidate.url, callbackUrl: failure.setupNeed === 'oauth-client' ? integrations.oauthRedirectUrl : undefined })
    : null
  const add = async () => {
    const installed = integrations.list.kind === 'loaded' ? integrations.list.integrations.find((item) => item.url === candidate.url) : undefined
    const integration = installed ?? await integrations.add({ name, url: candidate.url })
    if (integration) onAdded(integration)
  }
  return (
    <Card>
      <View style={{ gap: 2 }}>
        <Text numberOfLines={1} style={{ color: palette.text, fontSize: type.chrome, fontWeight: '500' }}>{request.name ?? 'MCP server'}</Text>
        <Text numberOfLines={1} style={{ color: palette.textTertiary, fontSize: type.dense }}>Enter its address to add it.</Text>
      </View>
      <Field
        label="Server address"
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="http://localhost:8000/mcp"
      />
      {address.trim() && !isValid ? <Banner message="Use an HTTPS address, or HTTP on localhost, with no credentials or fragment." /> : null}
      {failure ? <Banner message={failure.message} /> : null}
      <Button tone="primary" label="Add" busy={!!current && !failure} disabled={!integrations.connected || !isValid || (!!current && !failure)} onPress={() => void add()} />
      {setupHandoff ? <>
        <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{setupHandoff.hint}</Text>
        <Button label="Set up with an agent" disabled={!integrations.connected} onPress={() => onHandOff(setupHandoff)} />
      </> : null}
    </Card>
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
