import { SquareTerminal } from '@lucide/svelte'
import type { Command } from '../../command-palette/lib/commands'
import { addWslDistroStore } from '../add-wsl-distro.store.svelte'

/** The palette's "Add a WSL distro", offered only when this client's host runs Windows. */
export function addWslDistroPaletteCommands(): Command[] {
  if (!addWslDistroStore.windowsHostId) return []
  return [{
    id: 'add-wsl-distro',
    label: 'Add a WSL distro',
    group: 'Servers',
    icon: SquareTerminal,
    keywords: ['wsl', 'linux', 'ubuntu', 'distro', 'windows', 'machine', 'install'],
    run: () => void addWslDistroStore.open(),
  }]
}
