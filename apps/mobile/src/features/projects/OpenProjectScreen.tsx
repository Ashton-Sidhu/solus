// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useApp, useListened } from '../../app/app-context'
import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, ListRow, ListRowSymbol, ListSection, SectionTitle, LIST_ROW_ICON_SIZE } from './components/add-project-ui'
import { GithubProjectIcon } from './components/GithubProjectIcon'
import { useHostApi } from './use-open-project'
import { ProjectHostPicker } from './components/ProjectHostPicker'

/** The four ways to get a project onto the host, as T3 Code's Add project sources. */
export function OpenProjectScreen({ navigation, route }: ScreenProps<'OpenProject'>) {
  const { hostId } = route.params
  const api = useHostApi(hostId)
  const app = useApp()
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  // null while unknown: the row still opens the repository list, which answers for itself.
  const [githubStatus, setGithubStatus] = useState<{ hostId: string; connected: boolean } | null>(null)

  // Checked on every return: the person may have just connected GitHub.
  useFocusEffect(useCallback(() => {
    if (!api) return
    let live = true
    api.setupListGithubRepos().then(
      (result) => { if (live) setGithubStatus({ hostId, connected: result.connected }) },
      () => { if (live) setGithubStatus(null) },
    )
    return () => { live = false }
  }, [api, hostId]))

  const githubMissing = githubStatus?.hostId === hostId && githubStatus.connected === false
  return (
    <AddProjectShell title="Add project">
      <HostStatusBanner hostId={hostId} />
      {hosts.length > 1 || !api ? (
        <>
          <SectionTitle>Hosts</SectionTitle>
          <ProjectHostPicker hostId={hostId} onSelect={(nextHostId) => navigation.setParams({ hostId: nextHostId })} />
        </>
      ) : null}
      <ListSection>
        <ListRow
          disabled={!api}
          title="New project"
          subtitle="Start a new Git repository from a name"
          icon={<ListRowSymbol name="plus" />}
          isFirst
          onPress={() => navigation.navigate('NewProject', { hostId })}
        />
        <ListRow
          disabled={!api}
          title="Local folder"
          subtitle="Browse a folder on disk"
          icon={<ListRowSymbol name="folder.badge.plus" />}
          onPress={() => navigation.navigate('OpenFolder', { hostId })}
        />
        <ListRow
          disabled={!api}
          title="Git URL"
          subtitle="Clone from a remote URL"
          icon={<ListRowSymbol name="link" />}
          onPress={() => navigation.navigate('CloneProject', { hostId })}
        />
        {githubMissing ? (
          <ListRow
            disabled={!api}
            title="GitHub repository"
            subtitle="Connect GitHub to clone a repository"
            icon={<GithubProjectIcon size={LIST_ROW_ICON_SIZE} colorClassName="accent-icon" />}
            onPress={() => navigation.navigate('GitHubConnection', { hostId })}
          />
        ) : (
          <ListRow
            disabled={!api}
            title="GitHub repository"
            subtitle="Clone a repository your GitHub account can reach"
            icon={<GithubProjectIcon size={LIST_ROW_ICON_SIZE} colorClassName="accent-icon" />}
            onPress={() => navigation.navigate('ProjectFromGithub', { hostId })}
          />
        )}
      </ListSection>
    </AddProjectShell>
  )
}
