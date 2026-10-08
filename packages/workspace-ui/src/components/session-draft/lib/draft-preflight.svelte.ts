import { untrack } from 'svelte'
import type { PluginCommandsResult } from '@solus/contracts/types'
import { getSettingsContext, getWorkspaceContext } from '../../../contexts'
import { startsWorktree } from '../../../contexts/workspace/run-config'
import type { SessionDraft } from '../../../contexts/workspace/session-draft.svelte'
import { draftPluginCommandScope } from './plugin-command-scope'

/**
 * What a composer for a draft has to read before Send, since a draft has no
 * session to have read it already: the slash commands for the run its pickers
 * name, and the checkout behind the directory it points at. Every surface that
 * composes a draft — the draft pane and a page's docked composer — runs this.
 */
export function useDraftPreflight(getDraft: () => SessionDraft | null | undefined) {
  const session = getWorkspaceContext()
  const theme = getSettingsContext()

  // A draft has no session command cache. Load against the run selected in its
  // own model picker instead of borrowing commands from the active tab.
  let pluginCommands = $state<PluginCommandsResult>({ global: [], project: [] })
  let pluginCommandRequestSequence = 0
  $effect(() => {
    const current = getDraft()
    if (!current) return
    const scope = draftPluginCommandScope(
      current.run,
      theme.activeAgent,
      current.id,
      (workingDirectory, gitContext, sourceId) =>
        untrack(() => session.ctxForEnvironment(workingDirectory, gitContext, sourceId)),
    )
    // Reading both values makes a picker change invalidate this request even
    // when two models belong to the same provider.
    const requestIdentity =
      `${scope.provider}\0${scope.modelId ?? ''}\0${scope.workingDirectory}`
    const requestSequence = ++pluginCommandRequestSequence
    pluginCommands = { global: [], project: [] }
    void session
      .apiForRun(current.run)
      .getPluginCommands(scope.workingDirectory, scope.context)
      .then((result) => {
        if (requestSequence !== pluginCommandRequestSequence) return
        const latest = getDraft()
        if (!latest) return
        const latestIdentity =
          `${latest.run.provider ?? theme.activeAgent}\0${latest.run.modelConfig.modelId ?? ''}\0${latest.run.workingDirectory}`
        if (latestIdentity !== requestIdentity) return
        pluginCommands = result
      })
      .catch((error) => {
        if (requestSequence === pluginCommandRequestSequence)
          console.error('getPluginCommands failed', error)
      })
    return () => {
      if (requestSequence === pluginCommandRequestSequence)
        pluginCommandRequestSequence++
    }
  })

  // A draft names a directory before anything has read it — and when the
  // project was opened on another host, only that host can read it. Until it
  // answers there is no checkout, so the chips that describe the destination
  // have nothing to show. Same step a tab takes when it moves to a project, so
  // it goes through the same call. Re-runs whenever the draft is pointed
  // somewhere new, because choosing a project clears the checkout it had.
  $effect(() => {
    const current = getDraft()
    const cwd = current?.run.workingDirectory
    if (!current || current.run.gitContext || !cwd || cwd === '~') return
    const sourceId = current.id
    const worktreeRequested = startsWorktree(current.run)
    untrack(() => { void session.refreshStartTarget(sourceId, cwd, worktreeRequested) })
  })

  return {
    get pluginCommands() {
      return pluginCommands
    },
  }
}
