import type { AppShortcutRemoval } from '@solus/contracts/app-shortcuts'
import type { KeyPlatform } from '../../lib/keybindings/key-platform'
import type { AppShortcutChange } from './app-shortcuts.store.svelte'

/**
 * The text of each app shortcut command and its result (docs/app-shortcuts.md
 * §5). It names the Trash as the operating system does, because a removed
 * launcher goes there and the person takes it back from there.
 */

/** Where a removed launcher goes: null on Linux, which deletes it (docs/app-shortcuts.md §4). */
export function trashName(platform: KeyPlatform['id']): string | null {
  if (platform === 'mac') return 'Trash'
  if (platform === 'windows') return 'Recycle Bin'
  return null
}

/** The label of the shortcut command in the app menu. While a change runs, the label says which. */
export function shortcutCommandLabel(hasShortcut: boolean, change: AppShortcutChange | null): string {
  if (change === 'adding') return 'Adding shortcut…'
  if (change === 'removing') return 'Removing shortcut…'
  if (change === 'updating') return 'Updating shortcut…'
  return hasShortcut ? 'Remove app shortcut' : 'Add app shortcut'
}

export interface ShortcutMessage {
  message: string
  description?: string
}

/** What the person reads after one shortcut was removed: where its launcher is now. */
export function removalMessage(appName: string, removal: AppShortcutRemoval, trash: string | null): ShortcutMessage {
  if (removal.launcher === 'kept') {
    return {
      message: `The shortcut of ${appName} was removed, but its launcher stays.`,
      description: `Solus could not move the launcher to the ${trash ?? 'Trash'}. You can delete it: ${removal.launcherPath}`,
    }
  }
  const message = `The shortcut of ${appName} was removed from this computer.`
  if (removal.launcher === 'trashed' && trash) return { message, description: `Its launcher is in the ${trash}. You can restore it from there.` }
  return { message }
}

function countOf(count: number): string {
  return count === 1 ? '1 app shortcut' : `${count} app shortcuts`
}

/** The state line of the Settings row. A list that could not be read has no count: it says why. */
export function shortcutCountText(count: number, listError: string | null): string {
  if (listError) return `Solus could not read the app shortcuts of this computer: ${listError}`
  if (count === 0) return 'No app has a shortcut on this computer.'
  return count === 1 ? '1 app has a shortcut on this computer.' : `${count} apps have a shortcut on this computer.`
}

/** The question before Settings removes every shortcut. It names the count, so the person knows what goes. */
export function removeAllConfirmText(count: number, trash: string | null): string {
  if (count === 1) {
    const where = trash ? `Its launcher goes to the ${trash}.` : 'Its launcher is deleted.'
    return `Remove the 1 app shortcut from this computer? ${where} The app stays on its host.`
  }
  const where = trash ? `The launchers go to the ${trash}.` : 'The launchers are deleted.'
  return `Remove all ${count} app shortcuts from this computer? ${where} The apps stay on their hosts.`
}

/** The result of a removal of several shortcuts. */
export function removedCountMessage(removed: number, kept: number, trash: string | null): ShortcutMessage {
  const message = `${countOf(removed)} removed from this computer.`
  if (kept > 0) return { message, description: `Solus could not move ${kept === 1 ? '1 launcher' : `${kept} launchers`} to the ${trash ?? 'Trash'}. They stay and still open their apps.` }
  if (trash && removed > 0) return { message, description: `The launchers are in the ${trash}.` }
  return { message }
}

export function notRemovedMessage(failed: number, firstError: string): ShortcutMessage {
  return { message: `${countOf(failed)} not removed.`, description: firstError }
}

/** The offer after a host was removed from this client: its apps cannot open here without it. */
export function hostShortcutsOfferMessage(hostLabel: string, count: number): ShortcutMessage {
  return {
    message: `${hostLabel} has ${countOf(count)} on this computer.`,
    description: 'They cannot open their apps while this computer has no connection to the host.',
  }
}
