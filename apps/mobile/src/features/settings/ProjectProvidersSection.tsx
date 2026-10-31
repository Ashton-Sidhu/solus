import { View } from 'react-native'
import { changeProjectProviderOverride, providerProjectOverride, type ProjectProviderChange } from '@solus/contracts/provider-instance-models'
import { PROVIDERS } from '@solus/contracts/provider-model-settings'
import type { useProviderInstances } from './use-provider-instances'
import { SettingsSection } from './components/SettingsSection'
import { SettingsChoiceRow } from './components/SettingsChoiceRow'
import { SettingsActionRow } from './components/SettingsActionRow'
import { SettingsNote } from './components/SettingsNote'

export function ProjectProvidersSection({ projectPath, state }: { projectPath: string; state: ReturnType<typeof useProviderInstances> }) {
  const { client, view, readiness } = state
  const snapshot = view.snapshot
  const override = snapshot ? providerProjectOverride(snapshot.projects, projectPath) : undefined
  function save(change: ProjectProviderChange) {
    if (!snapshot) return
    void client.write({ expectedRevision: snapshot.revision, change: { kind: 'project', override: changeProjectProviderOverride(snapshot, projectPath, change) } })
  }
  if (readiness !== 'ready') return <SettingsNote>Connect this host to change project provider settings.</SettingsNote>
  return <View className="gap-4">
    <SettingsNote>Your private provider choices on this host. Inherit uses your host settings. These choices apply to all worktrees of this project.</SettingsNote>
    {view.error ? <SettingsNote>{view.error}</SettingsNote> : null}
    {view.loading ? <SettingsNote>Loading provider settings…</SettingsNote> : null}
    {snapshot && snapshot.configurationVersion !== 2 ? <SettingsNote>Update this host to use project provider overrides. Existing host settings still apply.</SettingsNote> : null}
    {snapshot?.configurationVersion === 2 ? <>
      {PROVIDERS.map((provider) => <SettingsSection key={provider.id} title={`${provider.label} instance for new sessions`}>
        <SettingsChoiceRow label="Inherit host choice" selected={!override?.selected[provider.id]} disabled={view.saving} onPress={() => save({ kind: 'selected', provider: provider.id, instanceId: null })} />
        {snapshot.instances.filter((instance) => instance.provider === provider.id).map((instance) => <SettingsChoiceRow key={instance.id} label={instance.displayName} selected={override?.selected[provider.id] === instance.id} disabled={view.saving} onPress={() => save({ kind: 'selected', provider: provider.id, instanceId: instance.id })} />)}
      </SettingsSection>)}
      {snapshot.instances.map((instance) => <SettingsSection key={instance.id} title={`${instance.displayName}: availability`}>
        <SettingsChoiceRow label={`Inherit host setting (${instance.enabled ? 'enabled' : 'disabled'})`} selected={override?.enabled[instance.id] === undefined} disabled={view.saving} onPress={() => save({ kind: 'enabled', instanceId: instance.id, enabled: null })} />
        <SettingsChoiceRow label="Enabled for this project" selected={override?.enabled[instance.id] === true} disabled={view.saving} onPress={() => save({ kind: 'enabled', instanceId: instance.id, enabled: true })} />
        <SettingsChoiceRow label="Disabled for this project" selected={override?.enabled[instance.id] === false} disabled={view.saving} onPress={() => save({ kind: 'enabled', instanceId: instance.id, enabled: false })} />
      </SettingsSection>)}
      <SettingsSection title="Reset">
        <SettingsActionRow icon="arrow.clockwise" label="Reset to host settings" disabled={!override || view.saving} onPress={() => save({ kind: 'reset' })} />
      </SettingsSection>
    </> : null}
  </View>
}
