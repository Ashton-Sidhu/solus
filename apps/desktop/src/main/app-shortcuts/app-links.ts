import type { AppWindowRequest } from '@solus/contracts/app-shortcuts'
import { parseAppLinkAction, type AppLinkAction } from '@solus/contracts/app-shortcut-links'
import type { AppShortcutRecords } from './app-shortcut-records'

/**
 * The app link or shortcut link in the arguments of a launch
 * (docs/app-shortcuts.md §4, §5). The launchers of Windows and Linux, and the
 * `solus` scheme on those systems, start Solus with the link as an argument,
 * and a Solus that runs gets the arguments of that second launch. Any other
 * argument, as a file or a switch, is not a link.
 */
export function appLinkActionIn(launchArguments: readonly string[]): AppLinkAction | null {
  for (const argument of launchArguments) {
    const action = parseAppLinkAction(argument)
    if (action) return action
  }
  return null
}

/** Links that wait for the app to be ready: Executor's limit, so a page cannot queue windows without end. */
export const MAX_WAITING_APP_LINKS = 4

/** Adds a link to those that wait. A link that already waits, or one past the limit, is dropped. */
export function queueAppLink(waiting: AppLinkAction[], action: AppLinkAction): boolean {
  const key = JSON.stringify(action)
  if (waiting.length >= MAX_WAITING_APP_LINKS || waiting.some((queued) => JSON.stringify(queued) === key)) return false
  waiting.push(action)
  return true
}

/**
 * The app window that a link opens. Each link opens the app; a shortcut link
 * also asks the person to add the shortcut, unless this computer has it. The
 * link never adds it: the person does, in the window, where the app's own
 * name shows.
 */
export function appWindowRequestFor(action: AppLinkAction, records: Pick<AppShortcutRecords, 'find'>): AppWindowRequest {
  const record = records.find(action.target)
  const linkName = action.kind === 'add-shortcut' ? action.name : null
  const request: AppWindowRequest = { ...action.target, name: record?.name ?? linkName ?? '' }
  if (action.kind === 'add-shortcut' && !record) request.offer = action.offer
  return request
}
