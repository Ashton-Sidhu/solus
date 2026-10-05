import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { ScreenProps } from '../../navigation/routes'
import { GroupedScroll, GroupedSection, NavigationRow } from '../../ui/grouped-rows'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { useHostApi } from './use-open-project'

/** The four ways to get a project onto the host, in plain words. */
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
    <GroupedScroll>
      <HostStatusBanner hostId={hostId} />
      <GroupedSection footer={githubMissing ? 'GitHub is not connected on this host. Tap "Connect GitHub" to connect it.' : undefined}>
        <NavigationRow label="Start a new project" onPress={() => navigation.navigate('NewProject', { hostId })} />
        <NavigationRow label="Open an existing folder" onPress={() => navigation.navigate('OpenFolder', { hostId })} />
        {githubMissing
          ? <NavigationRow label="Connect GitHub" value="Not connected" accessibilityHint="GitHub is not connected on this host" onPress={() => navigation.navigate('GitHubConnection', { hostId })} />
          : <NavigationRow label="Get a project from GitHub" onPress={() => navigation.navigate('ProjectFromGithub', { hostId })} />}
        <NavigationRow label="Clone from a URL" onPress={() => navigation.navigate('CloneProject', { hostId })} />
      </GroupedSection>
    </GroupedScroll>
  )
}
