// Adapted from T3 Code thread-route-state.ts at 9a26f217ac (MIT, see UPSTREAM.md).
import type { NavigationState } from '@react-navigation/native'
import type { RootStackParamList, ThreadDraft } from '../../navigation/routes'

type WorkspaceRoute = NavigationState<RootStackParamList>['routes'][number]

export function isDraftThreadRoute(route: WorkspaceRoute): route is WorkspaceRoute & { name: 'Thread'; params: RootStackParamList['Thread'] & { draft: ThreadDraft } } {
  if (route.name !== 'Thread') return false
  // SAFETY: the name guard above identifies the Thread route contract.
  const params = route.params as RootStackParamList['Thread'] | undefined
  return params?.draft !== undefined
}

/** Update the existing Thread route; clearing draft keeps its native screen key. */
export function submittedThreadParams(hostId: string, sessionId: string): RootStackParamList['Thread'] {
  return { draft: undefined, hostId, sessionId }
}
