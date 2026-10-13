import { useFocusEffect } from '@react-navigation/native'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useApp, useListened } from '../../../app/app-context'
import { pullRequestPermissions } from '../lib/pull-request-permissions'
import type { PullRequestRef } from '../pull-request-directory'
import { shownValue } from '../pull-request-reads'
import type { PullRequestView } from './pull-request-view'

/**
 * The pull request of one screen: its read state, the view every part reads,
 * and whether its host is connected. The pull request is read again when the
 * screen gets focus and when the host connects again.
 */
export function usePullRequestView(ref: PullRequestRef) {
  const app = useApp()
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf(ref))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(ref.hostId))?.viewerLogin ?? null)
  const connected = useListened(app.connections.changes, () => app.connections.state(ref.hostId)?.phase === 'connected')
  const detail = shownValue(state)
  const pr = detail?.overview.pullRequest ?? null
  const permissions = useMemo(() => pullRequestPermissions(pr, viewerLogin, connected), [pr, viewerLogin, connected])
  const view = useMemo<PullRequestView | null>(() => (detail && pr ? { ref, detail, pr, permissions, viewerLogin } : null), [ref, detail, pr, permissions, viewerLogin])
  const reload = useCallback(() => { void app.pullRequests.loadDetail(ref) }, [app, ref])

  useFocusEffect(reload)
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (connected && !wasConnected.current) reload()
    wasConnected.current = connected
  }, [connected, reload])
  return { state, view, connected, reload }
}
