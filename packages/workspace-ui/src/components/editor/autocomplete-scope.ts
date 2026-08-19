import type { Session } from '@solus/contracts/types'

interface AutocompleteWorkspace {
  activeTabId: string
  sessionFor(tabId: string): Session | undefined
}

export interface AutocompleteScope {
  tabId: string
  /** Explicit host for tab-less drafts. A started session can also supply it so
   *  file search does not depend on whichever tab is active. */
  serverId: string | undefined
  workingDirectory: string | undefined
}

export function autocompleteSessionChangedFiles(
  sessions: Readonly<Record<string, Session>>,
  sessionId: string | undefined,
): string[] {
  return sessionId
    ? (sessions[sessionId]?.sessionChangedFiles ?? [])
    : []
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
  ownerServerId?: string,
): AutocompleteScope {
  const tabId = ownerTabId ?? workspace.activeTabId
  const session = ownerTabId ? workspace.sessionFor(ownerTabId) : undefined
  return {
    tabId,
    serverId: ownerServerId ?? session?.run.serverId,
    workingDirectory:
      session?.run.gitContext?.worktreePath ??
      workingDirectory ??
      session?.run.workingDirectory,
  }
}
