import type { PluginCommandsResult } from '@solus/contracts/types'
import { getSettingsContext, getWorkspaceContext } from '../../../contexts'
import type { SessionDraft } from '../../../contexts/workspace/session-draft.svelte'
import { draftPluginCommandIdentity, draftPluginCommandScope } from './plugin-command-scope'

const NO_COMMANDS: PluginCommandsResult = { global: [], project: [] }

/**
 * What a composer for a draft reads that a session would already have: the
 * slash commands for the run its pickers name. Every surface that composes a
 * draft — the draft pane and a page's docked composer — runs this. The
 * checkout behind the draft's folder is read by the drafts store when the
 * draft moves (docs/plans/run-location.md §10).
 */
export function useDraftPreflight(getDraft: () => SessionDraft | null | undefined) {
  const session = getWorkspaceContext()
  const theme = getSettingsContext()

  // A draft has no session command cache. Commands are read against the run
  // selected in its own model picker, not borrowed from the active tab, and
  // only when the composer asks for them. Each identity is read once: a read
  // is keyed by a string, so a new run object with the same picks asks nothing.
  const commandIdentity = $derived.by(() => {
    const current = getDraft()
    return current ? draftPluginCommandIdentity(current.run, theme.activeAgent) : null
  })
  let loadedCommands = $state<{ identity: string; commands: PluginCommandsResult } | null>(null)
  let requestedIdentity: string | null = null

  function readPluginCommands(identity: string): void {
    const current = getDraft()
    if (!current || draftPluginCommandIdentity(current.run, theme.activeAgent) !== identity) return
    const scope = draftPluginCommandScope(
      current.run,
      theme.activeAgent,
      current.id,
      (workingDirectory, gitContext, sourceId) => session.ctxForEnvironment(workingDirectory, gitContext, sourceId),
    )
    void session
      .apiForRun(current.run)
      .getPluginCommands(scope.workingDirectory, scope.context)
      .then((commands) => {
        if (requestedIdentity === identity) loadedCommands = { identity, commands }
      })
      .catch((error) => {
        if (requestedIdentity === identity) console.error('getPluginCommands failed', error)
      })
  }

  const pluginCommands = $derived.by(() => {
    const identity = commandIdentity
    if (!identity) return NO_COMMANDS
    if (loadedCommands?.identity === identity) return loadedCommands.commands
    if (requestedIdentity !== identity) {
      requestedIdentity = identity
      // Read after this derivation settles: a request may write state, which a
      // derivation must not do.
      queueMicrotask(() => readPluginCommands(identity))
    }
    return NO_COMMANDS
  })

  return {
    get pluginCommands() {
      return pluginCommands
    },
  }
}
