import { Building2, RefreshCw, Laptop } from '@lucide/svelte'
import type { Via } from '@solus/contracts/analytics-events'
import type { Command } from '../../command-palette/lib/commands'
import type { SettingsTab } from '../../../contexts/workspace/routing/route-registry'

/**
 * Palette entries for the settings pages that have an owner of their own
 * (plans/018 §7): personal sync, the organization's settings, and this device.
 * Shared by desktop and web so both expose the same entry points.
 */
export function settingsOwnerCommands(shell: { showSettings(tab: SettingsTab, via: Via): void }): Command[] {
  return [{
    id: 'open-settings-sync',
    label: 'Settings sync',
    group: 'General',
    icon: RefreshCw,
    keywords: ['sync', 'account', 'personal', 'devices', 'cloud', 'preferences'],
    run: () => shell.showSettings('personal', 'palette'),
  }, {
    id: 'open-organization-settings',
    label: 'Organization settings',
    group: 'General',
    icon: Building2,
    keywords: ['organization', 'insights', 'owner', 'team'],
    run: () => shell.showSettings('organization', 'palette'),
  }, {
    id: 'open-this-device-settings',
    label: 'This device settings',
    group: 'General',
    icon: Laptop,
    keywords: ['device', 'font', 'installed', 'local'],
    run: () => shell.showSettings('device', 'palette'),
  }]
}
