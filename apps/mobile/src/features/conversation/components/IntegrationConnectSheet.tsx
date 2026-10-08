import { Modal, ScrollView, Text } from 'react-native'
import { useListened } from '../../../app/app-context'
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
 * next step after it closes, so focus returns to the composer.
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
    <Modal visible presentationStyle="pageSheet" animationType="slide" onRequestClose={dismiss}>
      <ScrollView style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={{ color: palette.text, fontSize: type.title, fontWeight: '600' }}>{`Connect ${integrationName}`}</Text>
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
            {`The agent needs your ${integrationName} account to use its tools. Your sign-in stays on the host.`}
          </Text>
          <Button tone="primary" label="Connect" disabled={!flows.connected} onPress={() => void flows.connect(integrationId, integrationName)} />
        </>}
        {!flow || flow.step === 'starting' ? <Button label="Dismiss" onPress={dismiss} /> : null}
      </ScrollView>
    </Modal>
  )
}
