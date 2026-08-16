import type { RunConfig, Session } from '../../../../shared/types'
import type { SessionDraft } from '../../../contexts/workspace/session-draft.svelte'

/** What the pill's dock composes for right now. */
export interface PillComposerTarget {
  /** The conversation behind the bar, or null when nothing has started. */
  sessionId: string | null
  /** The tab the bar is docked beside. A draft has none, and an addressed tab
   *  is what every tab-routed action in the bar fires at — so it must be unset
   *  rather than left pointing at the conversation the draft covered. */
  tabId: string | undefined
  /** How the target will run: the draft's own run while it composes, the
   *  session's after it starts. */
  run: RunConfig | undefined
}

/**
 * The pill renders one fixed set of surfaces instead of a route outlet, so a
 * session draft never mounts a composer of its own there the way it does in the
 * editor. The dock composes for it instead — which only works if the bar stops
 * being addressed by the active tab the moment a draft takes the leading pane.
 */
export function pillComposerTarget(
  draft: SessionDraft | null,
  activeSession: Session | undefined,
  activeTabId: string,
): PillComposerTarget {
  if (draft) return { sessionId: null, tabId: undefined, run: draft.run }
  return {
    sessionId: activeSession?.id ?? null,
    tabId: activeTabId,
    run: activeSession?.run,
  }
}
