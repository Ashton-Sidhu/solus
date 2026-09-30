// The lifecycle moves a pull request row offers without opening it: on the row
// while Shift is held, in the row's context menu, and as Shift+letter on the
// highlighted row. One list, so the three paths never disagree about what a
// row can do.

import type { PullRequest as PullRequestFacts } from '@solus/contracts/providers'
import type { PullRequest } from '../../../contexts/prs/pull-request.svelte'
import { toasts } from '../../../lib/toasts'
import { MERGE_METHOD_OPTIONS, defaultMergeMethod } from '../../pr-review/lib/merge-method'

export type PrRowActionKind = 'merge' | 'close' | 'reopen' | 'ready'

export interface PrRowAction {
  kind: PrRowActionKind
  /** The compact word the row shows. */
  label: string
  /** The context menu's fuller wording. */
  menuLabel: string
  /** The letter that runs it with Shift on the highlighted row. */
  key: string
}

const ROW_ACTIONS = {
  merge: { label: 'Merge', menuLabel: 'Merge pull request…', key: 'M' },
  close: { label: 'Close', menuLabel: 'Close pull request', key: 'C' },
  reopen: { label: 'Reopen', menuLabel: 'Reopen pull request', key: 'O' },
  ready: { label: 'Ready', menuLabel: 'Mark ready for review', key: 'R' },
} satisfies Record<PrRowActionKind, Omit<PrRowAction, 'kind'>>

type RowFacts = Pick<PullRequestFacts, 'state' | 'draft' | 'viewerPermissions' | 'capabilities'>

/** What this viewer may do to the row from the list. A merged pull request has
 *  nothing left to do; a draft offers "ready" in place of a merge it cannot make. */
export function prRowActions(pr: RowFacts): PrRowAction[] {
  const kinds: PrRowActionKind[] =
    pr.state === 'closed' ? ['reopen']
      : pr.state === 'open' ? [pr.draft ? 'ready' : 'merge', 'close']
        : []
  return kinds
    .filter((kind) => pr.viewerPermissions.actions.includes(kind))
    .filter((kind) => kind !== 'merge' || pr.capabilities.mergeMethods.length > 0)
    .map((kind) => ({ kind, ...ROW_ACTIONS[kind] }))
}

/** The row action a Shift+letter keystroke names, or null. Any other modifier
 *  belongs to a global shortcut, not to the row. */
export function prRowActionForKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>,
  actions: PrRowAction[],
): PrRowActionKind | null {
  if (!event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return null
  return actions.find((action) => action.key === event.key.toUpperCase())?.kind ?? null
}

/** What the merge confirmation dialog says. */
export interface PrMergeConfirmation {
  title: string
  description: string
  confirmLabel: string
}

/** The merge confirmation, with the method named, because a row has no method
 *  menu and merges with the repository's default. */
export function prMergeConfirmation(
  pr: Pick<PullRequestFacts, 'number' | 'title' | 'baseRef' | 'capabilities'>,
): PrMergeConfirmation {
  const method = defaultMergeMethod(pr.capabilities.mergeMethods)
  const option = MERGE_METHOD_OPTIONS.find((candidate) => candidate.value === method)
  return {
    title: `Merge #${pr.number}?`,
    description: `“${pr.title}” lands on ${pr.baseRef}. ${option?.hint ?? ''}`.trim(),
    confirmLabel: option?.action ?? 'Merge pull request',
  }
}

/**
 * Run a row action through the pull request's own store commands, which show
 * the outcome at once and take it back if the host refuses. The refusal is
 * reported here, because a row has no place of its own to show it.
 */
export async function runPrRowAction(pullRequest: PullRequest, kind: PrRowActionKind): Promise<void> {
  try {
    if (kind === 'merge') await pullRequest.merge(defaultMergeMethod(pullRequest.capabilities.mergeMethods))
    else await pullRequest.updateLifecycle(kind, pullRequest.headSha)
  } catch (error) {
    toasts.error(kind === 'merge' ? "Couldn't merge the pull request" : "Couldn't update the pull request", {
      description: error instanceof Error ? error.message : String(error),
    })
  }
}
