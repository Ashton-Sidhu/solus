import { getContext, setContext } from 'svelte'

/**
 * What the work pane knows about its draft, for the header controls several
 * components below it (History, Review): the body version the pane is based
 * on, and the commands that must name that version. A context, because each
 * shell (document, diagram, artifact) renders the header, and none of them
 * owns the draft. Outside a work pane there is none.
 */
export interface WorkPaneContext {
  /** The `contentVersion` of the body the reader sees. A live work first reads
   *  the body the host wrote from everyone's edits. */
  contentVersion: () => Promise<number>
  /** Whether the pane holds edits it has not saved. */
  isDirty: () => boolean
  /** Whether the reader may change the body: not a viewer, not Google-linked. */
  canEdit: () => boolean
  /** Make one checkpoint current again over the pane's base, then show it. */
  restoreRevision: (revisionId: number) => Promise<void>
}

const KEY = Symbol('work-pane')

export function setWorkPaneContext(context: WorkPaneContext): void {
  setContext(KEY, context)
}

export function getWorkPaneContext(): WorkPaneContext | null {
  return getContext<WorkPaneContext | undefined>(KEY) ?? null
}
