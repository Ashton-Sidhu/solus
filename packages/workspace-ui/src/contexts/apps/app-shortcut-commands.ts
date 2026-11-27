import type { AppShortcutTarget, AppShortcutView } from '@solus/contracts/app-shortcuts'
import type { AppSummary } from '@solus/contracts/apps'
import { CURRENT_KEYS } from '../../lib/keybindings/key-platform'
import { toasts } from '../../lib/toasts'
import { appShortcutsStore } from './app-shortcuts.store.svelte'
import {
  hostShortcutsOfferMessage,
  notRemovedMessage,
  removalMessage,
  removeAllConfirmText,
  removedCountMessage,
  trashName,
} from './app-shortcut-messages'

/**
 * The shortcut commands with their messages (docs/app-shortcuts.md §5). Each
 * one shows a running toast while the main process writes or removes the
 * launcher, and turns it into the result. A failure names what went wrong and
 * offers "Try again". The store refuses a second change of the same shortcut.
 */

type ShortcutApp = Pick<AppSummary, 'id' | 'name' | 'colorHue'>

const trash = () => trashName(CURRENT_KEYS.id)

export async function addAppShortcut(target: AppShortcutTarget, app: ShortcutApp): Promise<void> {
  if (appShortcutsStore.changeFor(target)) return
  const progress = toasts.progress('Adding shortcut…')
  try {
    await appShortcutsStore.add(target, app)
    progress.success(`${app.name} has a shortcut on this computer.`)
  } catch (error) {
    progress.error('The shortcut was not added', {
      description: error instanceof Error ? error.message : String(error),
      action: { label: 'Try again', onAction: () => void addAppShortcut(target, app) },
    })
  }
}

/** Removes one shortcut. True when its record is gone, so a caller can close what showed it. */
export async function removeAppShortcut(target: AppShortcutTarget, appName: string): Promise<boolean> {
  if (appShortcutsStore.changeFor(target)) return false
  const progress = toasts.progress('Removing shortcut…')
  try {
    const removal = await appShortcutsStore.remove(target)
    if (!removal) {
      progress.dismiss()
      return false
    }
    const { message, description } = removalMessage(appName, removal, trash())
    progress.info(message, { description })
    return true
  } catch (error) {
    progress.error('The shortcut was not removed', {
      description: error instanceof Error ? error.message : String(error),
      action: { label: 'Try again', onAction: () => void removeAppShortcut(target, appName) },
    })
    return false
  }
}

async function removeShortcuts(shortcuts: readonly AppShortcutView[]): Promise<void> {
  if (shortcuts.length === 0) return
  const progress = toasts.progress(shortcuts.length === 1 ? 'Removing shortcut…' : `Removing ${shortcuts.length} shortcuts…`)
  try {
    const result = await appShortcutsStore.removeMany(shortcuts)
    if (result.failed.length === 0) {
      const { message, description } = removedCountMessage(result.removed.length, result.kept.length, trash())
      progress.info(message, { description })
      return
    }
    const { message, description } = notRemovedMessage(result.failed.length, result.failed[0].message)
    progress.error(message, {
      description,
      action: { label: 'Try again', onAction: () => void removeShortcuts(result.failed.map((failure) => failure.shortcut)) },
    })
  } catch (error) {
    progress.error('The shortcuts were not removed', { description: error instanceof Error ? error.message : String(error) })
  }
}

/** Settings: every shortcut of this computer goes, after a question that names the count. */
export async function removeAllAppShortcuts(confirmRemoval: (question: string) => boolean = (question) => confirm(question)): Promise<void> {
  const shortcuts = [...appShortcutsStore.list]
  if (shortcuts.length === 0 || !confirmRemoval(removeAllConfirmText(shortcuts.length, trash()))) return
  await removeShortcuts(shortcuts)
}

/**
 * After a host was removed from this client, its apps cannot open here. The
 * person chooses: the offer removes the shortcuts of that host's apps, and a
 * shortcut that stays shows the app as unavailable when it is opened.
 */
export async function offerToRemoveHostAppShortcuts(serverId: string, removedHost: { installationId?: string; label: string } | undefined): Promise<void> {
  await appShortcutsStore.loaded()
  // A shortcut names its host as a sidebar pin does (`appPinOf`): by installation id, else by connection id.
  const host = removedHost?.installationId || serverId
  const shortcuts = appShortcutsStore.ofHost(host)
  if (shortcuts.length === 0) return
  const { message, description } = hostShortcutsOfferMessage(removedHost?.label ?? 'The removed host', shortcuts.length)
  toasts.info(message, {
    description,
    duration: 15_000,
    action: { label: shortcuts.length === 1 ? 'Remove shortcut' : 'Remove shortcuts', onAction: () => void removeShortcuts(appShortcutsStore.ofHost(host)) },
  })
}
