// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, ListRow, ListRowSymbol, ListSection } from './components/add-project-ui'
import { useHostApi } from './use-open-project'

/** The four ways to get a project onto the host, as T3 Code's Add project sources. */
export function OpenProjectScreen({ navigation, route }: ScreenProps<'OpenProject'>) {
  const { hostId } = route.params
  const api = useHostApi(hostId)
  // null while unknown: the row still opens the repository list, which answers for itself.
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null)

  // Checked on every return: the person may have just connected GitHub.
  useFocusEffect(useCallback(() => {
    if (!api) return
    let live = true
    api.setupListGithubRepos().then(
      (result) => { if (live) setGithubConnected(result.connected) },
      () => { if (live) setGithubConnected(null) },
    )
    return () => { live = false }
  }, [api]))

  const githubMissing = githubConnected === false
  return (
    <AddProjectShell>
      <HostStatusBanner hostId={hostId} />
      <ListSection>
        <ListRow
          title="New project"
          subtitle="Start an empty project in the projects folder"
          icon={<ListRowSymbol name="plus" />}
          isFirst
          onPress={() => navigation.navigate('NewProject', { hostId })}
        />
        <ListRow
          title="Local folder"
          subtitle="Open a folder on the host"
          icon={<ListRowSymbol name="folder.badge.plus" />}
          onPress={() => navigation.navigate('OpenFolder', { hostId })}
        />
        {githubMissing ? (
          <ListRow
            title="Connect GitHub"
            subtitle="GitHub is not connected on this host"
            icon={<ListRowSymbol name="arrow.triangle.branch" />}
            onPress={() => navigation.navigate('GitHubConnection', { hostId })}
          />
        ) : (
          <ListRow
            title="GitHub repository"
            subtitle="Clone a repository your GitHub account can reach"
            icon={<ListRowSymbol name="arrow.triangle.branch" />}
            onPress={() => navigation.navigate('ProjectFromGithub', { hostId })}
          />
        )}
        <ListRow
          title="Git URL"
          subtitle="Clone from a remote URL"
          icon={<ListRowSymbol name="link" />}
          onPress={() => navigation.navigate('CloneProject', { hostId })}
        />
      </ListSection>
    </AddProjectShell>
  )
}
