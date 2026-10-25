import { Alert } from 'react-native'
import type { SolusApp } from '../../app/solus-app'
import type { SolusProjectShell } from '../threads/thread-directory'
import { projectRemovalFailure, projectRemovalPrompt, projectRemovalScope, removeProjectCheckouts } from './project-removal'

/**
 * Asks before the project leaves every host's list (pingdotgg/t3code#21409),
 * then reads the changed hosts' projects again. `onRemoved` runs only when
 * no checkout stays listed: the project filter has nothing left to show.
 */
export function confirmRemoveProject(
  app: SolusApp,
  projects: readonly SolusProjectShell[],
  projectKey: string,
  onRemoved: () => void,
): void {
  const scope = projectRemovalScope(projects, projectKey)
  if (!scope) return
  const remove = async () => {
    const result = await removeProjectCheckouts(scope.projects, (hostId) =>
      app.connections.state(hostId)?.readiness === 'ready' ? (app.connections.connection(hostId)?.api ?? null) : null)
    await Promise.all(result.changedHostIds.map((hostId) => app.threads.load(hostId)))
    const failure = projectRemovalFailure(scope, result)
    if (failure) Alert.alert(failure.title, failure.message)
    else onRemoved()
  }
  const prompt = projectRemovalPrompt(scope)
  Alert.alert(prompt.title, prompt.message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => void remove() },
  ])
}
