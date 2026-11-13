import { Radar, Unplug } from '@lucide/svelte'
import type { Command } from '../command-palette/lib/commands'
import { connectionsNav } from '../connections/connections-nav.svelte'
import { discoverStore } from './discover.store.svelte'

/**
 * The palette's way into the fleet (docs/plans/host-fleet.md D11), for desktop and
 * web alike: "Add machine" opens the Add page, and "Find hosts nearby" opens the
 * fleet and scans. `showHosts` opens Settings › Hosts in the shell that asks.
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
  ]
}
