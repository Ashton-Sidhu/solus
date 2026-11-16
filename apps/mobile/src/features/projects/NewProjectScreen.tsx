// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useRef, useState } from 'react'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { ThemedSwitch } from '../../components/ThemedSwitch'
import { useGithubConnection } from '../settings/use-github-connection'
import { ProjectHostPicker } from './components/ProjectHostPicker'
import { AddProjectShell, AddProjectTextInput, ListRow, ListRowSymbol, ListSection, PrimaryActionButton, LIST_ROW_ICON_SIZE } from './components/add-project-ui'
import { GithubProjectIcon } from './components/GithubProjectIcon'
import { newProjectLocationText } from './lib/open-project'
import { errorText, useHostApi, useMounted, useProjectsFolder, useShowProject } from './use-open-project'
import { safeProjectDirName } from '@solus/contracts/project-folder-name'
import { createProject } from './lib/create-project'

/** A new, empty project in the host's projects folder, as T3 Code's New project. The location is the host's; it does not change here. */
export function NewProjectScreen({ navigation, route }: ScreenProps<'NewProject'>) {
  const { hostId } = route.params
  const app = useApp()
  const api = useHostApi(hostId)
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label) ?? 'this host'
  const projectsFolder = useProjectsFolder(hostId)
  const showProject = useShowProject(hostId, navigation)
  const mounted = useMounted()
  const github = useGithubConnection(hostId)
  const canPublish = github.view.kind === 'connected' || (github.view.kind === 'account' && github.view.status?.kind === 'connected')
  const [name, setName] = useState('')
  const [publishes, setPublishes] = useState(false)
  const [createdPath, setCreatedPath] = useState<string | null>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (!api || !name.trim() || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await createProject(api, { name, existingPath: createdPath, publishes, organizationId: app.account.organizationId })
      if (!mounted.current) return
      setCreatedPath(result.path)
      if (result.kind === 'unpublished') setError(result.error)
      else showProject(result.path)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <AddProjectShell title="New project">
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
        editable={!busy && !createdPath}
      />
      <Text className="px-1 text-sm leading-snug text-foreground-muted" numberOfLines={2}>
        {projectsFolder ? newProjectLocationText(name, projectsFolder, hostLabel) : 'Reading project location…'}
      </Text>
      <ProjectHostPicker hostId={hostId} disabled={busy || createdPath !== null} onSelect={(nextHostId) => {
        setPublishes(false)
        setError(null)
        navigation.setParams({ hostId: nextHostId })
      }} />
      {canPublish || publishes ? (
        <ListSection>
          <ListRow title="Create private repository on GitHub" subtitle={name.trim() ? safeProjectDirName(name) : 'Private repository'}
            icon={<GithubProjectIcon size={LIST_ROW_ICON_SIZE} colorClassName="accent-icon" />} isFirst disabled={busy || createdPath !== null}
            right={<ThemedSwitch accessibilityLabel="Create private repository on GitHub" value={publishes} disabled={busy || createdPath !== null} onValueChange={setPublishes} />}
            onPress={() => setPublishes((value) => !value)} />
        </ListSection>
      ) : null}
      <PrimaryActionButton label={createdPath ? 'Retry publishing' : 'Create project'} loading={busy} disabled={busy || !api || !name.trim()} onPress={() => void create()} />
      {createdPath && error ? <PrimaryActionButton label="Open local project" disabled={busy} onPress={() => showProject(createdPath)} /> : null}
      <ListSection>
        <ListRow
          title="Add existing project"
          subtitle="Open a folder or clone a repository"
          icon={<ListRowSymbol name="folder.badge.plus" />}
          isFirst
          disabled={busy}
          onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.replace('OpenProject', { hostId })}
        />
      </ListSection>
    </AddProjectShell>
  )
}
