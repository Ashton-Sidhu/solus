import { Platform, ScrollView, Text } from 'react-native'
import { useListened } from '../../../app/app-context'
import { AppSheet } from '../../../components/AppSheet'
import { usePalette } from '../../../theme/theme'
import { space, type } from '../../../theme/tokens'
import { Banner, Button } from '../../../ui/primitives'
import { IntegrationConnectPanel } from '../../settings/components/IntegrationConnectPanel'
import { useIntegrationConnect } from '../../settings/use-integrations'
import type { ConversationStore } from '../conversation-store'

/**
 * An integration tool of this session's turn needs the person's own connection
 * (`integration.connectNeeded`, docs/plans/mcp-integrations.md §4.1 rule 2).
 * Connect runs the same flow as the Integrations row, here in the sheet;
 * Dismiss closes it and stops a sign-in still waiting. Typing is the natural
 * next step after it closes, so focus returns to the composer. T3 has no
 * connect sheet in a thread; this is T3's `AppSheet`, its sheet for local
 * thread context that the owner dismisses. Its Done (or a swipe) dismisses.
 */
export function IntegrationConnectSheet({ store, onClose }: { store: ConversationStore; onClose(): void }) {
  const palette = usePalette()
  const { controller } = store
  const request = useListened(controller.connectNeededChanges, () => controller.connectNeeded)
  const flows = useIntegrationConnect(controller.hostId)
  if (!request) return null
  const { integrationId, integrationName } = request
  const flow = flows.flows.get(integrationId)
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
          <Button tone="primary" label="Connect" disabled={!flows.connected} onPress={() => void flows.connect({ id: integrationId, name: integrationName })} />
        </>}
        {!flow || flow.step === 'starting' ? <Button label="Dismiss" onPress={dismiss} /> : null}
      </ScrollView>
    </AppSheet>
  )
}
