import { SquareTerminal } from '@lucide/svelte'
import type { Command } from '../../command-palette/lib/commands'
import { addOverSshStore } from '../add-over-ssh.store.svelte'

/** The palette's "Add machine over SSH", for desktop and web alike. */
export function addOverSshPaletteCommand(): Command {
  return {
    id: 'add-over-ssh',
    label: 'Add machine over SSH',
    group: 'Servers',
    icon: SquareTerminal,
    keywords: ['ssh', 'remote', 'host', 'machine', 'server', 'forward', 'install'],
    run: () => addOverSshStore.open(),
  }
}
