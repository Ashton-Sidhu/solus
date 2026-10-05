import { Settings, Smartphone } from '@lucide/svelte'
import type { Via } from '@solus/contracts/analytics-events'
import { devicesStore } from '../../../contexts/devices/devices.store.svelte'
import { requestInputFocus } from '../../../lib/inputFocus'
import type { Command } from '../../command-palette/lib/commands'
import type { SettingsTab } from '../../../contexts/workspace/routing/route-registry'

/**
 * How shells reach the Devices pane and Settings → Devices: the command
 * palette and a session's device being opened by an agent or another client. Shared by desktop, web
 * and mobile so every client exposes the same entry points.
 */

interface DeviceShell {
  openDevices(sessionId?: string, serverId?: string): void
  showSettings(tab: SettingsTab, via: Via): void
  focusedChatTabId: string | null
  sessionFor(tabId: string): { id: string } | undefined
}

export function deviceCommands(shell: DeviceShell): Command[] {
  return [{
    id: 'open-devices',
    label: 'Open Devices',
    group: 'View',
    icon: Smartphone,
    keywords: ['device', 'simulator', 'emulator', 'ios', 'android', 'iphone', 'ipad', 'phone', 'native'],
    run: () => shell.openDevices(),
  }, {
    id: 'open-device-settings',
    label: 'Open device settings',
    group: 'General',
    icon: Settings,
    keywords: ['device', 'simulator', 'emulator', 'agent access', 'ssh', 'setup', 'preferences'],
    run: () => shell.showSettings('devices', 'palette'),
  }]
}

/**
 * A device was opened in a session. Reveal it only beside that same
 * conversation, never by switching to an unrelated one, and give typing focus
 * back to the composer. An agent's open respects the auto-show setting.
 */
export function revealDeviceSurface(
  shell: DeviceShell,
  serverId: string,
  payload: { sessionId: string; openedBy: 'user' | 'agent' },
): void {
  const settings = devicesStore.state(serverId)?.settings
  if (payload.openedBy === 'agent' && settings?.autoShowAgentDevices === false) return
  const focusedTabId = shell.focusedChatTabId
  const focusedSessionId = focusedTabId ? shell.sessionFor(focusedTabId)?.id : undefined
  if (focusedSessionId !== payload.sessionId) return
  shell.openDevices(payload.sessionId, serverId)
  requestInputFocus()
}
