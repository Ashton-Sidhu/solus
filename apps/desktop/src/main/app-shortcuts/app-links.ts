import { parseAppLink, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'

/**
 * The app link in the arguments of a launch (docs/app-shortcuts.md §4). The
 * launchers of Windows and Linux start Solus with the link as an argument,
 * and a Solus that runs gets the arguments of that second launch. Any other
 * argument, as a file or a switch, is not a link.
 */
export function appLinkTargetIn(launchArguments: readonly string[]): AppShortcutTarget | null {
  for (const argument of launchArguments) {
    const target = parseAppLink(argument)
    if (target) return target
  }
  return null
}
