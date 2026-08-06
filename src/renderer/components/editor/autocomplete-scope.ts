import type { Session } from '../../../shared/types'

interface AutocompleteWorkspace {
  activeTabId: string
  sessionFor(tabId: string): Session | undefined
}

export interface AutocompleteScope {
  tabId: string
  workingDirectory: string | undefined
}

/**
 * A tab-bound composer follows the checkout where its agent actually runs.
 * Detached editors keep their explicit project directory but still route
 * through the active tab's host.
 */
export function resolveAutocompleteScope(
  workspace: AutocompleteWorkspace,
  workingDirectory: string | undefined,
  ownerTabId: string | undefined,
): AutocompleteScope {
  const tabId = ownerTabId ?? workspace.activeTabId
  const session = ownerTabId ? workspace.sessionFor(ownerTabId) : undefined
  return {
    tabId,
    workingDirectory:
      session?.run.gitContext?.worktreePath ??
      workingDirectory ??
      session?.run.workingDirectory,
  }
}
