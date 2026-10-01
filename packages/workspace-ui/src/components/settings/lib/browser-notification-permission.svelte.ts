import { track } from '../../../lib/analytics'

/**
 * This browser's grant for system alerts. The "System alert" switch is a host
 * setting shared by every client, so a browser that has not granted
 * permission needs its own way to ask. Electron grants it by default, and a
 * shell without the Notification API has nothing to ask for.
 */
export class BrowserNotificationPermission {
  state = $state<NotificationPermission | null>(
    globalThis.Notification ? globalThis.Notification.permission : null,
  )

  /** Ask only from a user gesture; browsers penalize an unprompted request. */
  async request(): Promise<void> {
    if (this.state !== 'default') return
    this.state = await globalThis.Notification.requestPermission()
    track('push_permission_result', { granted: this.state === 'granted' })
  }

  /** The system alert row's description, or why this browser cannot show one. */
  systemAlertDescription(isOn: boolean, description: string): string {
    if (!isOn) return description
    if (this.state === 'default') return 'Allow notifications in this browser to receive alerts.'
    if (this.state === 'denied') return "Notifications are blocked in this browser's site settings."
    return description
  }
}
