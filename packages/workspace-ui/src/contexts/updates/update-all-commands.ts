import { Download } from '@lucide/svelte'
import type { Command } from '../../components/command-palette/lib/commands'
import { hostUpdatesStore } from './host-updates.store.svelte'
import { hostUpdater } from './host-updater.svelte'

/** The palette's "Update all", for desktop and web alike. */
export function updateAllPaletteCommands(): Command[] {
  const updates = hostUpdatesStore.installableUpdates
  if (!updates.length || hostUpdater.isRunning) return []
  return [{
    id: 'update-all',
    label: updates.length === 1 ? 'Install 1 host update' : `Install ${updates.length} host updates`,
    group: 'General', icon: Download,
    keywords: ['update all', 'upgrade', 'install', 'claude', 'codex', 'host', 'provider'],
    run: () => void hostUpdater.update(updates),
  }]
}
