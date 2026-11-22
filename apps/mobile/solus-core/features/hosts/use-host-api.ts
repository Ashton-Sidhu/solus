import { useApp, useListened } from '../../app/app-context'

/** The host's API while it is connected; null otherwise, so a screen shows the host banner. */
export function useHostApi(hostId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  return readiness === 'ready' ? app.connections.connection(hostId)?.api ?? null : null
}
