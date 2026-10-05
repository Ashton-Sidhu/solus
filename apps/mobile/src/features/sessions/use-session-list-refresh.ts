import { useCallback, useEffect } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useApp, useListened } from '../../app/app-context'

/** A burst of status changes (a turn starting and settling) reads the list once. */
const STATUS_RELOAD_DELAY_MS = 600

/**
 * Keeps one project's session list current: it reads on (re)connect, when its
 * screen comes back into view (a conversation pushed over it may have started
 * a session), and after the host reports a session's status changed (the iPad
 * sidebar stays on screen beside a running conversation).
 */
export function useSessionListRefresh(hostId: string, projectPath: string): void {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const reload = useCallback(() => { void app.sessions.loadSessions(hostId, projectPath) }, [app, hostId, projectPath])

  useEffect(() => {
    if (phase === 'connected' || phase === undefined) reload()
  }, [phase, reload])

  useFocusEffect(reload)

  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = connection.events.subscribe('session.statusChanged', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(reload, STATUS_RELOAD_DELAY_MS)
    })
    return () => {
      stop()
      if (timer) clearTimeout(timer)
    }
  }, [app, hostId, reload])
}
