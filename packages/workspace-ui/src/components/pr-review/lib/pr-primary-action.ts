import type { PullRequest } from '@solus/contracts/providers'
import type { MergeMethod } from '@solus/contracts/types'
import { MERGE_METHOD_OPTIONS, defaultMergeMethod } from './merge-method'
import {
  armedAutoMergeLabel,
  autoMergeLabel,
  prMenuHostActions,
  type MergeAction,
  type MergeReadiness,
} from './merge-readiness'

/**
 * The pull request's one action, as the header and the status card draw it:
 * the number, then the move the readiness model chose, coloured by the state
 * it changes. With no move for this viewer it reports the state instead, so
 * the number always says where the pull request stands.
 */
export type PrPrimaryTone = 'primary' | 'negative' | 'positive' | 'review' | 'neutral'

export interface PrPrimaryAction {
  /** What one click runs. Null when the button only reports a state. */
  move: MergeAction | null
  label: string
  tone: PrPrimaryTone
  /** The full sentence for the tooltip and screen readers. */
  title: string
}

/** The methods the caret offers, and the move each one changes. */
export interface PrPrimaryMenu {
  /** Pick the method for the merge or auto-merge the button runs. */
  methods: MergeMethod[]
  mergeNow: boolean
  enableAutoMerge: boolean
  disableAutoMerge: boolean
  /** The method "Merge now" and "Enable auto-merge" use. */
  method: MergeMethod
}

/** The move with the reader's method in place of the model's default. */
export function withMethod(move: MergeAction, method: MergeMethod): MergeAction {
  if (move.kind === 'merge') {
    const label = MERGE_METHOD_OPTIONS.find((option) => option.value === method)?.action ?? move.label
    return { kind: 'merge', label, method }
  }
  if (move.kind === 'enable-auto-merge') return { kind: 'enable-auto-merge', label: autoMergeLabel(method), method }
  return move
}

/** The method the reader picked, if the host still allows it, else the host's. */
export function pickedMethod(detail: PullRequest, picked: MergeMethod | null): MergeMethod {
  const methods = detail.capabilities.mergeMethods
  return picked && methods.includes(picked) ? picked : defaultMergeMethod(detail.capabilities)
}

const MOVE_TITLES = {
  merge: 'Merge this pull request now',
  'enable-auto-merge': 'Ask the host to merge this once its requirements pass',
  'mark-ready': 'Mark the pull request ready for review',
  'update-branch': 'Bring the base branch into this branch on the host',
  'resolve-conflicts': 'Open an agent session to resolve the merge conflicts',
  'fix-checks': 'Open a session composer with the fix for the failing checks drafted',
} satisfies { [Kind in MergeAction['kind']]: string }

export function prPrimaryAction(
  detail: PullRequest,
  readiness: MergeReadiness,
  picked: MergeMethod | null,
): PrPrimaryAction {
  if (readiness.key === 'merged') {
    return { move: null, label: 'Merged', tone: 'review', title: readiness.headline }
  }
  if (readiness.key === 'closed') {
    return { move: null, label: 'Closed', tone: 'negative', title: 'Closed without merging' }
  }
  if (readiness.action) {
    const move = withMethod(readiness.action, pickedMethod(detail, picked))
    return {
      move,
      label: move.label,
      tone: move.kind === 'resolve-conflicts' ? 'negative' : 'primary',
      title: MOVE_TITLES[move.kind],
    }
  }
  const armed = armedAutoMergeLabel(detail)
  if (armed) {
    return { move: null, label: armed, tone: 'positive', title: `${armed}: the host merges this once its requirements pass` }
  }
  return {
    move: null,
    label: readiness.headline,
    tone: readiness.blocked ? 'negative' : 'neutral',
    title: readiness.note ? `${readiness.headline}. ${readiness.note}` : readiness.headline,
  }
}

export function prPrimaryMenu(detail: PullRequest, action: PrPrimaryAction): PrPrimaryMenu {
  const host = prMenuHostActions(detail, action.move)
  const choosesMethod = action.move?.kind === 'merge' || action.move?.kind === 'enable-auto-merge'
  return {
    methods: choosesMethod && detail.capabilities.mergeMethods.length > 1 ? detail.capabilities.mergeMethods : [],
    mergeNow: host.mergeNow,
    enableAutoMerge: host.enableAutoMerge,
    disableAutoMerge: host.disableAutoMerge,
    method: action.move?.kind === 'merge' || action.move?.kind === 'enable-auto-merge' ? action.move.method : host.method,
  }
}

export function hasPrimaryMenuItems(menu: PrPrimaryMenu): boolean {
  return menu.methods.length > 0 || menu.mergeNow || menu.enableAutoMerge || menu.disableAutoMerge
}
