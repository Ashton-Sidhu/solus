// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useState } from 'react'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, AddProjectTextInput, ListRow, ListRowSymbol, ListSection, PrimaryActionButton } from './components/add-project-ui'
import { folderNameOf, newProjectLocationText } from './lib/open-project'
import { errorText, useHostApi, useMounted, useProjectsFolder, useShowProject } from './use-open-project'

/** A new, empty project in the host's projects folder, as T3 Code's New project. The location is the host's; it does not change here. */
export function NewProjectScreen({ navigation, route }: ScreenProps<'NewProject'>) {
  const { hostId } = route.params
  const app = useApp()
  const api = useHostApi(hostId)
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label) ?? 'this host'
  const projectsFolder = useProjectsFolder(hostId)
  const showProject = useShowProject(hostId, navigation)
  const mounted = useMounted()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (!api || !name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const project = await api.setupCreateProject({ name: name.trim() })
      showProject(project.path)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <AddProjectShell>
      <HostStatusBanner hostId={hostId} />
      {error ? <ErrorBanner message={error} /> : null}
      <AddProjectTextInput
        accessibilityLabel="Project name"
        placeholder="Project name"
        value={name}
        onChangeText={setName}
        autoCapitalize="sentences"
        autoFocus
        returnKeyType="done"
        onSubmitEditing={() => void create()}
        editable={!busy}
      />
      <Text className="px-1 text-sm leading-snug text-foreground-muted" numberOfLines={2}>
        {newProjectLocationText(name, projectsFolder ? folderNameOf(projectsFolder) : 'the projects folder', hostLabel)}
      </Text>
      <PrimaryActionButton label="Create project" loading={busy} disabled={busy || !api || !name.trim()} onPress={() => void create()} />
      <ListSection>
        <ListRow
          title="Add existing project"
          subtitle="Open a folder or clone a repository"
          icon={<ListRowSymbol name="folder.badge.plus" />}
          isFirst
          onPress={() => navigation.navigate('OpenProject', { hostId })}
        />
      </ListSection>
    </AddProjectShell>
  )
}
