import { View } from 'react-native';
import { isProviderUpdateActive } from '@solus/contracts/host-update-types';
import { providerCheckText, providerUpdateDetail } from '@solus/client-core/provider-update-text';
import { SettingsSection } from './components/SettingsSection';
import { SettingsValueRow } from './components/SettingsValueRow';
import { SettingsActionRow } from './components/SettingsActionRow';
import { SettingsSwitchRow } from './components/SettingsSwitchRow';
import { SettingsNote } from './components/SettingsNote';
import { useHostSettings } from './use-host-settings';
import type { HostVersionView } from './use-host-update-status';

export function ProviderUpdatesSection({ hostId, updates, mayEdit }: { hostId: string; updates: HostVersionView; mayEdit: boolean }) {
  const { state, update } = useHostSettings(hostId);
  const status = updates.status;
  if (!status || status.install === 'cloud') return null;
  return (
    <View className="gap-3">
      <SettingsSection title="Coding agents">
        {status.providers.map((provider) => {
          const name = provider.agent === 'claude' ? 'Claude Code' : 'Codex';
          const installation = provider.installation;
          const busy = isProviderUpdateActive(provider.update);
          const disabled = !mayEdit || busy || updates.requesting;
          return (
            <View key={provider.agent}>
              <SettingsValueRow icon="sparkles" label={name} value={provider.installedVersion ?? (installation?.path ? 'Version unknown' : 'Not installed')} detail={[providerCheckText(provider), providerUpdateDetail(provider)].filter(Boolean).join('\n')} />
              {provider.check.kind === 'available' && installation?.canUpdate !== false ? (
                <SettingsActionRow icon="arrow.up.circle" label={provider.update?.phase === 'failed' ? `Retry ${name} update` : `Update ${name}`} disabled={disabled} loading={busy} onPress={() => updates.installProvider(provider.agent)} />
              ) : installation?.method === 'absent' ? (
                <SettingsActionRow icon="plus" label={`Install ${name}`} disabled={disabled} onPress={() => updates.installProvider(provider.agent)} />
              ) : null}
              {installation && installation.method !== 'absent' && (!installation.managed || installation.existingPath) ? (
                <SettingsActionRow icon="arrow.clockwise" label={installation.managed ? `Use existing ${name} installation` : `Use native ${name} installation`} description="Active turns keep their current version. The existing installation stays on the host." disabled={disabled} onPress={() => updates.installProvider(provider.agent, installation.managed ? 'existing' : 'native')} />
              ) : null}
            </View>
          );
        })}
        {state.kind === 'loaded' && status.providers.some((provider) => provider.installation) ? (
          <SettingsSwitchRow icon="arrow.clockwise" label="Automatic agent updates" subtitle="Update native agents installed through Solus on this host. Active turns keep their current version." value={state.settings.agentAutoUpdates} disabled={!mayEdit} onValueChange={(enabled) => update({ agentAutoUpdates: enabled })} />
        ) : null}
      </SettingsSection>
      {!mayEdit ? <SettingsNote>Only a host administrator can change agent installations and updates.</SettingsNote> : null}
      {state.kind === 'error' ? <SettingsNote tone="danger">{state.message}</SettingsNote> : null}
    </View>
  );
}
