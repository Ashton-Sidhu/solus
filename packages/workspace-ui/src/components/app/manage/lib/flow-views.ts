import { createContext } from 'svelte'
import type { AppSignalActionView } from '@solus/contracts/apps'

/**
 * What the custom nodes of a flow canvas read that changes more often than
 * the graph: the clock, the selection, and the commands. A canvas sets its
 * view once, with getters, so a tick of the clock or a new selection does not
 * build the nodes again (docs/plans/apps.md §9.2).
 */

export interface RunFlowView {
  readonly now: number
  readonly selectedStep: string | null
  selectStep(name: string): void
}

export const [getRunFlowView, setRunFlowView] = createContext<RunFlowView>()

export interface SignalFlowView {
  /** A narrow pane stacks the nodes: edges join their tops and bottoms, not their sides. */
  readonly isStacked: boolean
  readonly isBusy: boolean
  /** The action whose editor is open under the canvas. */
  readonly editingActionId: string | null
  summaryOf(action: AppSignalActionView): string
  /** Opens the editor of `action`, or of a new action with null. */
  edit(action: AppSignalActionView | null): void
  setEnabled(action: AppSignalActionView, enabled: boolean): void
}

export const [getSignalFlowView, setSignalFlowView] = createContext<SignalFlowView>()
