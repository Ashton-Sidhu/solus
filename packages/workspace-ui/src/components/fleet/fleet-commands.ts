import { AppWindow, KeyRound, Radar, Unplug } from '@lucide/svelte'
import type { Command } from '../command-palette/lib/commands'
import { connectionsNav } from '../connections/connections-nav.svelte'
import { pairCodeRequest } from '../connections/lib/access-tab-requests.svelte'
import { outsideAppsKeywords } from '../connections/lib/outside-apps'
import { outsideAppsDialog } from '../connections/outside-apps/outside-apps-dialog.svelte'
import { hosts } from '../../contexts/hosts/hosts.svelte'
import { discoverStore } from './discover.store.svelte'

/**
 * The palette's way into the fleet, for desktop and
 * web alike: "Add machine" opens the Add page, and "Find hosts nearby" opens the
 * fleet and scans. "Show pairing code" opens this device's host on its Access
 * tab with a code made (docs/plans/add-machine-card.md). "Use Solus in other
 * apps" opens its dialog for this device's host, else the Run on host
 * (plans/035 §10). `showHosts` opens Settings › Hosts in the shell that asks.
 */
export function fleetPaletteCommands(showHosts: () => void): Command[] {
  return [
    {
      id: 'add-server',
      label: 'Add machine',
      group: 'Servers',
      icon: Unplug,
      keywords: ['add host', 'remote', 'pair', 'connect', 'cloud', 'link', 'machine'],
      run: () => {
        connectionsNav.openAdd()
        showHosts()
      },
    },
    {
      id: 'find-hosts',
      label: 'Find hosts nearby',
      group: 'Servers',
      icon: Radar,
      keywords: ['discover', 'scan', 'lan', 'tailscale', 'nearby', 'ssh config', 'wsl'],
      run: () => {
        connectionsNav.back()
        showHosts()
        void discoverStore.scan()
      },
    },
    {
      id: 'show-pairing-code',
      label: 'Show pairing code',
      group: 'Servers',
      icon: KeyRound,
      keywords: ['pair', 'code', 'pairing', 'access', 'connect device', 'add machine', 'link'],
      run: () => {
        // On web, the device is the host the page is served by.
        const serverId = (hosts.device ?? hosts.runOn)?.id
        if (serverId) {
          pairCodeRequest.ask(serverId)
          connectionsNav.open(serverId, 'access')
        }
        showHosts()
      },
    },
    {
      id: 'use-solus-in-other-apps',
      label: 'Use Solus in other apps',
      group: 'Servers',
      icon: AppWindow,
      keywords: outsideAppsKeywords(),
      run: () => {
        const serverId = (hosts.device ?? hosts.runOn)?.id
        if (serverId) outsideAppsDialog.open(serverId)
        else showHosts()
      },
    },
  ]
}
