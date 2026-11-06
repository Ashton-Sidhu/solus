import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { toasts } from '../../lib/toasts'

/**
 * Whether this computer runs its local host (docs/plans/desktop-remote-only.md).
 * A change relaunches the app, so `isOff` holds for the life of the window.
 */
class LocalHostStore {
  /** A change is on its way. It stays set on success: the app is relaunching. */
  isSwitching = $state(false)

  /** Only the desktop app has a local host to turn off. */
  get canSwitch(): boolean {
    return !!localApi.setLocalHostEnabled
  }

  get isOff(): boolean {
    return serverConnections.isLocalHostOff()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.isSwitching) return
    this.isSwitching = true
    try {
      await localApi.setLocalHostEnabled(enabled)
    } catch {
      this.isSwitching = false
      toasts.error(`Could not turn ${enabled ? 'on' : 'off'} the local host`)
    }
  }
}

export const localHostStore = new LocalHostStore()
