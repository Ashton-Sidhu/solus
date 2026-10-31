import { hostPathBaseName, sameHostPath } from '@solus/contracts/host-path'
import { useEffect, useState } from 'react'
import { ScreenScrollView } from '../../components/ScreenScrollView'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { SettingsScreen } from './components/SettingsScreen'
import { SettingsSection } from './components/SettingsSection'
import { SettingsNote } from './components/SettingsNote'
import { SelectionRow, hostMachineKind } from '../threads/NewTaskContextPickerScreens'
import { EnvironmentMachineSymbol } from '../../components/EnvironmentMachineSymbol'
import { ProjectFavicon } from '../../components/ProjectFavicon'
import { AppTextInput } from '../../components/AppText'
import { SettingsActionRow } from './components/SettingsActionRow'

export function SettingsScopeScreen({ route, navigation }: ScreenProps<'SettingsScope'>) {
  const app = useApp()
  const { hostId, projectPath, axis = "project" } = route.params
  const [query, setQuery] = useState("")
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const needle = query.trim().toLowerCase()
  const projects = useListened(app.threads.changes, app.threads.projects)
  const state = useListened(app.threads.changes, () => app.threads.stateOf(hostId))
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label ?? hostId)
  useEffect(() => { if (app.threads.stateOf(hostId).kind === 'idle') void app.threads.load(hostId) }, [app, hostId])
  function select(next?: string) {
    navigation.popTo('ProviderInstances', { hostId, projectPath: next })
  }
  if (axis === "host") return <SettingsScreen title="Settings host">
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-5 px-5 py-4">
      <AppTextInput accessibilityLabel="Search hosts" placeholder="Search hosts" value={query} onChangeText={setQuery} />
      <SettingsSection>
        {hosts.filter((host) => host.label.toLowerCase().includes(needle)).map((host) => <SelectionRow key={host.id} fullLabels title={host.label} selected={host.id === hostId}
          icon={<EnvironmentMachineSymbol kind={hostMachineKind(host.os)} size={18} tintColorClassName="accent-icon-muted" />}
          onPress={() => navigation.popTo("ProviderInstances", { hostId: host.id, projectPath: host.id === hostId ? projectPath : undefined })} />)}
      </SettingsSection>
    </ScreenScrollView>
  </SettingsScreen>
  return <SettingsScreen title="Apply settings for">
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-5 px-5 py-4">
      <SettingsNote>{`Choose which projects these provider settings apply to on ${hostLabel}.`}</SettingsNote>
      <AppTextInput accessibilityLabel="Search projects" placeholder="Search projects" value={query} onChangeText={setQuery} />
      <SettingsSection title="Scope">
        <SelectionRow fullLabels title="All projects" selected={!projectPath} onPress={() => select()} />
        {projectPath && !projects.some((item) => item.hostId === hostId && sameHostPath(item.project.path, projectPath)) ? <SelectionRow fullLabels title={hostPathBaseName(projectPath)} subtitle={projectPath} selected onPress={() => select(projectPath)} /> : null}
        {projects.filter((item) => item.hostId === hostId && `${item.project.folderName} ${item.project.path}`.toLowerCase().includes(needle)).map(({ key, project }) => <SelectionRow key={key} fullLabels title={project.folderName} icon={<ProjectFavicon environmentId={hostId} size={20} projectTitle={project.folderName} workspaceRoot={project.path} />} subtitle={project.path} selected={!!projectPath && sameHostPath(project.path, projectPath)} onPress={() => select(project.path)} />)}
      </SettingsSection>
      {state.kind === 'loading' ? <SettingsNote>Loading projects…</SettingsNote> : null}
      {state.kind === 'error' ? <SettingsNote>{state.message}</SettingsNote> : null}
      {state.kind === 'loaded' && !projects.some((item) => item.hostId === hostId) ? <SettingsNote>No projects yet. Open a folder on this host first.</SettingsNote> : null}
      <SettingsSection><SettingsActionRow icon="arrow.clockwise" label="Refresh projects" disabled={state.kind === 'loading'} onPress={() => { void app.threads.load(hostId) }} /></SettingsSection>
    </ScreenScrollView>
  </SettingsScreen>
}
