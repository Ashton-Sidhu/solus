import { useFocusEffect } from '@react-navigation/native'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useApp, useListened } from '../../../app/app-context'
import { pullRequestPermissions } from '../lib/pull-request-permissions'
import { FOCUS_FRESH_MS, type PullRequestRef } from '../pull-request-directory'
import { shownValue } from '../pull-request-reads'
import type { PullRequestView } from './pull-request-view'

/**
 * The pull request of one screen: its read state, the view every part reads,
 * and whether its host is connected. The pull request is read again when the
 * host connects again, on a refresh, and when the screen gets focus after
 * `FOCUS_FRESH_MS`. While the screen has focus, PR sync on the host keeps the
 * pull request and its checks fresh and pushes their changes; the checks
 * come only from there. The stacked screens of one pull request each read it
 * when the host connects again, and those reads join into one.
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
  /** A person's refresh: always a new read. */
  const reload = useCallback(() => { void app.pullRequests.loadDetail(ref, { force: true }) }, [app, ref])

  useFocusEffect(useCallback(() => {
    void app.pullRequests.loadDetail(ref, { freshFor: FOCUS_FRESH_MS })
    return app.pullRequests.want(ref.hostId, ref.projectPath, [{ kind: 'review', number: ref.number }])
  }, [app, ref]))
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (connected && !wasConnected.current) void app.pullRequests.loadDetail(ref)
    wasConnected.current = connected
  }, [app, ref, connected])
  return { state, view, connected, reload }
}
