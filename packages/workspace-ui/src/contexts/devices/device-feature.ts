import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { DeviceShell } from '../../components/devices/lib/device-entry'

/**
 * The part of Devices that is always loaded. The devices store and its
 * surfaces load on first use, not with the workspace. A device event can come
 * before that: an agent opens a device in the conversation, or a host's
 * devices change. This listener loads the store at the first event; the store
 * then follows every host itself and reads each one in full. A request to show
 * a device is handed over, so it is never lost.
 */
export function followDeviceRequests(shell: DeviceShell): () => void {
  const loadStore = () => import('./devices.store.svelte')
  const unsubscribers = [
    subscribeAllHosts('device.surfaceRequested', (serverId, payload) => {
      void import('../../components/devices/lib/device-entry').then(({ revealDeviceSurface }) => revealDeviceSurface(shell, serverId, payload))
    }),
    subscribeAllHosts('device.stateChanged', () => void loadStore()),
  ]
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
