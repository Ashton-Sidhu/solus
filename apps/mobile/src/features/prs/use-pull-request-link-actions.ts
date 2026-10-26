import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import * as Haptics from 'expo-haptics'
import { useMemo } from 'react'
import { useApp } from '../../app/app-context'
import type { RootStackParamList } from '../../navigation/routes'
import type { PullRequestLinkActions } from './lib/pull-request-link'

/** How a tapped pull request link opens on this phone. The screen is pushed,
 *  so a link in one pull request opens another above it and Back returns. */
export function usePullRequestLinkActions(): PullRequestLinkActions {
  const app = useApp()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  return useMemo(() => ({
    listProjects: async (hostId) => {
      const connection = app.connections.connection(hostId)
      return connection?.state.readiness === 'ready' ? connection.api.listProjects() : []
    },
    openPullRequest: (ref) => {
      void Haptics.selectionAsync()
      navigation.push('PullRequest', ref)
    },
    openBrowser: (href) => void app.platform.openBrowser(href),
  }), [app, navigation])
}
