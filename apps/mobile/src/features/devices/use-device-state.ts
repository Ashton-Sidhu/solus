import { useCallback, useEffect, useRef, useState } from 'react'
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
export function useDeviceState(hostId: string) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const owner = useRef(hostId)
  owner.current = hostId
  const epoch = useRef(0)
  const [view, setView] = useState<DeviceStateView>({ kind: 'loading' })

  const refresh = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return Promise.resolve()
    const expectedEpoch = epoch.current
    return connection.api.deviceList().then(
      (state) => {
        if (owner.current !== hostId || epoch.current !== expectedEpoch) return
        setView((current) => current.kind === 'loaded' && current.state.revision >= state.revision ? current : { kind: 'loaded', state })
      },
      (cause: unknown) => { if (owner.current === hostId && epoch.current === expectedEpoch) setView({ kind: 'error', message: deviceErrorText(cause) }) },
    )
  }, [app, hostId])

  useEffect(() => {
    epoch.current++
    if (phase === 'connected') {
      setView({ kind: 'loading' })
      void refresh()
    } else setView({ kind: 'error', message: 'Connect this host to run the app.' })
  }, [phase, refresh])

  useFocusEffect(useCallback(() => void refresh(), [refresh]))

  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (!connection || phase !== 'connected') return
    return connection.events.subscribe('device.stateChanged', ({ state }) => {
      if (owner.current !== hostId) return
      setView((current) => (current.kind === 'loaded' && state.revision <= current.state.revision ? current : { kind: 'loaded', state }))
    })
  }, [app, hostId, phase])

  return { view, refresh }
}
