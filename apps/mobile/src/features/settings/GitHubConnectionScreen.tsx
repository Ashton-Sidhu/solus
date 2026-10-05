import { Alert, RefreshControl, Text, View } from 'react-native'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { CODE_FONT } from '../../theme/tokens'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { ActionRow, GroupedFooter, GroupedScroll, GroupedSection, ValueRow } from '../../ui/grouped-rows'
import { useGithubConnection } from './use-github-connection'

/** Connect, watch, or disconnect the host's GitHub account. */
export function GitHubConnectionScreen({ route }: ScreenProps<'GitHubConnection'>) {
  const { hostId } = route.params
  const palette = usePalette()
  const { view, refresh, connect, cancel, disconnect } = useGithubConnection(hostId)

  const confirmDisconnect = () => Alert.alert('Disconnect GitHub?', 'This host stops reading pull requests until GitHub is connected again. Every device that uses the host is affected.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Disconnect',
      style: 'destructive',
      onPress: () => void disconnect().catch((cause: unknown) => Alert.alert('Not disconnected', cause instanceof Error ? cause.message : String(cause))),
    },
  ])

  return (
    <GroupedScroll refreshControl={<RefreshControl refreshing={view.kind === 'loading'} onRefresh={refresh} />}>
      <HostStatusBanner hostId={hostId} />
      {view.kind === 'connecting' ? (
        <GroupedSection title="Sign in to GitHub" footer="Enter this code on the GitHub page that opened. This screen updates when GitHub confirms.">
          {view.prompt ? (
            <View style={{ padding: 14, gap: 7, alignItems: 'center' }}>
              <Text selectable accessibilityLabel={`Code ${view.prompt.userCode.split('').join(' ')}`} style={{ color: palette.text, fontSize: 30, letterSpacing: 4, fontFamily: CODE_FONT }}>
                {view.prompt.userCode}
              </Text>
              <Text selectable style={{ color: palette.textTertiary, fontSize: 14 }}>{view.prompt.verificationUri}</Text>
            </View>
          ) : (
            <ValueRow label="Status" value="Asking GitHub for a code…" />
          )}
          <ActionRow label="Cancel" tone="danger" isFirst={false} onPress={cancel} />
        </GroupedSection>
      ) : (
        <GroupedSection title="GitHub">
          {view.kind === 'connected' ? (
            <>
              <ValueRow label="Account" value={view.login ?? 'Connected'} />
              <ActionRow icon="disconnect" label="Disconnect" tone="danger" isFirst={false} onPress={confirmDisconnect} />
            </>
          ) : (
            <>
              <ValueRow label="Status" value={view.kind === 'loading' ? 'Checking…' : view.kind === 'error' ? 'Unavailable' : 'Not connected'} />
              <ActionRow icon="connect" label="Connect GitHub" tone="accent" isFirst={false} disabled={view.kind === 'loading'} onPress={() => void connect()} />
            </>
          )}
        </GroupedSection>
      )}
      {view.kind === 'error' ? <GroupedFooter tone="danger" text={view.message} /> : null}
      <GroupedFooter text="The host keeps the GitHub token. This device never holds it." />
    </GroupedScroll>
  )
}
