import { expect, mock, test } from 'bun:test'

/**
 * Devices are not part of the first screen: the store and its surfaces load
 * on first use. A device event can come first, so one small listener is always
 * there. It loads the store at the first event and hands a request to show a
 * device to the code that shows it, so the request is not lost. Once loaded,
 * the store reads every host that is already ready: those readiness changes
 * passed before it existed.
 */

type Handler = (serverId: string, payload: unknown) => void
const handlers = new Map<string, Handler[]>()
const readinessListeners: Array<(serverId: string, status: string) => void> = []
const reads: string[] = []
const reveals: Array<{ serverId: string; payload: unknown }> = []

mock.module('@solus/client-core/host-events', () => ({
  subscribeAllHosts: (topic: string, handler: Handler) => {
    handlers.set(topic, [...(handlers.get(topic) ?? []), handler])
    return () => handlers.set(topic, (handlers.get(topic) ?? []).filter((each) => each !== handler))
  },
}))
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    connectedServerIds: () => ['ready-host', 'dialing-host'],
    readinessFor: (serverId: string) => ({ readiness: serverId === 'ready-host' ? 'ready' : 'connecting' }),
    onReadinessChange: (listener: (serverId: string, status: string) => void) => {
      readinessListeners.push(listener)
      return () => {}
    },
    apiFor: (serverId: string) => ({
      deviceState: async () => {
        reads.push(serverId)
        return { revision: 1, settings: {}, hosts: [], hostStatuses: [], devices: [], previews: [], booting: [], controls: [], runs: [] }
      },
    }),
  },
}))
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { show: () => {}, error: () => {}, success: () => {} } }))
mock.module('@solus/workspace-ui/components/devices/lib/device-entry', () => ({
  revealDeviceSurface: (_shell: unknown, serverId: string, payload: unknown) => {
    reveals.push({ serverId, payload })
  },
}))

const emit = (topic: string, serverId: string, payload: unknown) => {
  for (const handler of handlers.get(topic) ?? []) handler(serverId, payload)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a device request before the devices code loads is shown, and the store then reads every ready host', async () => {
  const { followDeviceRequests } = await import('@solus/workspace-ui/contexts/devices/device-feature')
  const shell = { focusedChatTabId: null }
  // SAFETY: the listener only hands the shell on; the test's reveal does not read it.
  const stop = followDeviceRequests(shell as never)
  expect([...handlers.keys()].sort()).toEqual(['device.stateChanged', 'device.surfaceRequested'])

  const request = { sessionId: 's1', devicePreviewId: 'p1', openedBy: 'agent' }
  emit('device.surfaceRequested', 'ready-host', request)
  await settle()
  expect(reveals).toEqual([{ serverId: 'ready-host', payload: request }])

  // The first state change loads the store, and the store reads what is ready now.
  expect(reads).toEqual([])
  emit('device.stateChanged', 'ready-host', { state: {} })
  await settle()
  await settle()
  expect(reads).toEqual(['ready-host'])
  expect(readinessListeners.length).toBe(1)

  // A host that becomes ready later is read when it does.
  readinessListeners[0]('dialing-host', 'ready')
  await settle()
  expect(reads).toEqual(['ready-host', 'dialing-host'])
  stop()
  expect(handlers.get('device.surfaceRequested')).toEqual([])
})
