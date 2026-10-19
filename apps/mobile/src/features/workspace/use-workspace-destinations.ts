import { StackActions, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useCallback } from 'react'
import { Keyboard } from 'react-native'

import type { RootStackParamList } from '../../navigation/routes'
import { useWorkspaceTabs } from './WorkspaceTabsContext'
import { workspaceDestinationChange, type WorkspaceDestination } from './workspace-destinations'

/**
 * The selected Android destination and the command that chooses one. The
 * caller says whether Settings is on top: a screen reads its navigator's
 * state, and the workspace layout reads the root stack it already follows.
 */
export function useWorkspaceDestinations(settingsOpen: boolean) {
  const workspace = useWorkspaceTabs()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const { dispatch } = workspace
  const selectedTab = workspace.state.selectedTab
  const selected: WorkspaceDestination = settingsOpen ? 'settings' : selectedTab
  const choose = useCallback(
    (destination: WorkspaceDestination) => {
      Keyboard.dismiss()
      const change = workspaceDestinationChange(navigation.getState(), selectedTab, destination)
      if (change.pop > 0) navigation.dispatch(StackActions.pop(change.pop))
      if (change.select) dispatch({ type: 'select', tab: change.select })
      if (change.openSettings) navigation.navigate('Settings')
    },
    [dispatch, navigation, selectedTab],
  )
  return { selected, choose }
}
