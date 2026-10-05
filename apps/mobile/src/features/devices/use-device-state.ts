import { useCallback, useEffect, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { parseDeviceError, type DeviceState } from '@solus/contracts/device-types'
import { useApp, useListened } from '../../app/app-context'

export type DeviceStateView =
  | { kind: 'loading' }
  | { kind: 'loaded'; state: DeviceState }
  | { kind: 'error'; message: string }

/** A host error as one readable sentence, without the wire prefix. */
export function deviceErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const parsed = parseDeviceError(message)
  if (parsed) return parsed.message
  return /not (registered|found|a function)|unknown method/i.test(message) ? 'This host does not support device builds. Update Solus on it.' : message
}

/**
 * One host's device snapshot: discovered when the screen comes into view (a
 * phone may have been plugged in), then kept current by the host's events.
 * An event older than the snapshot shown is ignored.
 */
export function useDeviceState(hostId: string): { view: DeviceStateView; refresh: () => void } {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [view, setView] = useState<DeviceStateView>({ kind: 'loading' })

  const refresh = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    connection.api.deviceList().then(
      (state) => setView({ kind: 'loaded', state }),
      (cause: unknown) => setView({ kind: 'error', message: deviceErrorText(cause) }),
    )
  }, [app, hostId])

  useEffect(() => {
    if (phase === 'connected') refresh()
  }, [phase, refresh])

  useFocusEffect(refresh)

  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    return connection.events.subscribe('device.stateChanged', ({ state }) => {
      setView((current) => (current.kind === 'loaded' && state.revision <= current.state.revision ? current : { kind: 'loaded', state }))
    })
  }, [app, hostId])

  return { view, refresh }
}
