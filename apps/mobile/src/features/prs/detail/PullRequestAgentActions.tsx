// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestAgentActions.ts and PullRequestControls.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useApp } from '../../../app/app-context'
import type { RootStackParamList } from '../../../navigation/routes'
import { pullRequestAgentActions, type PullRequestAgentTask } from '../lib/pull-request-agent-tasks'
import { usePullRequestAction } from './use-pull-request-action'
import type { PullRequestView } from './pull-request-view'

/**
 * Starts agent work on the pull request in a new session and opens it. The
 * host makes the checkout, so this needs the host now: Solus keeps no queue
 * of agent work for later, and offline the actions say so.
 */
export function usePullRequestAgent(view: PullRequestView) {
  const app = useApp()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const action = usePullRequestAction(view.ref)
  const actions = pullRequestAgentActions(view.pr, view.permissions.canUpdateHead)
  const start = (task: PullRequestAgentTask, question = '') => action.perform('Could not start the agent', async () => {
    const session = await app.pullRequestActions.startAgentWork(view.ref, task, view.pr, question)
    navigation.navigate('Thread', session)
  })
  return { actions, start, busy: action.busy, starting: action.running === 'agent', available: view.permissions.connected }
}

export const AGENT_OFFLINE_REASON = 'Agent work needs the host now. It cannot be queued offline.'
