import type { MergeMethod } from '@solus/contracts/types'
import type { PullRequest } from '@solus/contracts/providers'
import type { PrChecksState } from '@solus/contracts/checks-types'
import { MERGE_METHOD_OPTIONS, defaultMergeMethod } from '../../pr-review/lib/merge-method'

/**
 * The one action the project rail offers for the branch's pull request. The
 * rail is the compact surface: it makes the merge the code host allows, with
 * that host's preferred method, and leaves method choice, lifecycle changes,
 * and reviewer work to the pull request pane.
 */
export type LinkedPrPrimaryAction =
  | { kind: 'merge'; label: string; method: MergeMethod }
  /** The branch conflicts with its base — merging is not the next step. */
  | { kind: 'resolve-conflicts'; label: string }
  /** A draft asks to be marked ready before anything can land. */
  | { kind: 'ready'; label: string }
  /** The host says this pull request cannot merge; the row reports why. */
  | { kind: 'blocked'; label: string; reason: string }
  /** Nothing to offer: merged, closed, or the viewer may not act. */
  | { kind: 'none' }

type LinkedPrChecksState = PrChecksState | 'unavailable'

function mergeActionLabel(method: MergeMethod): string {
  return MERGE_METHOD_OPTIONS.find((option) => option.value === method)?.action ?? 'Merge pull request'
}

export function linkedPrPrimaryAction(
  detail: PullRequest | null,
  checksState?: LinkedPrChecksState,
): LinkedPrPrimaryAction {
  if (!detail || detail.state !== 'open') return { kind: 'none' }
  const allowed = new Set(detail.viewerPermissions.actions)
  // A draft cannot merge at all, so the rail promotes the step that unblocks it
  // rather than showing a merge row that could never run.
  if (detail.draft) {
    return allowed.has('ready')
      ? { kind: 'ready', label: 'Mark ready for review' }
      : { kind: 'none' }
  }
  const methods = detail.capabilities.mergeMethods
  if (!detail.capabilities.actions.includes('merge') || !allowed.has('merge') || methods.length === 0)
    return { kind: 'none' }
  // `dirty` is the host's word for "conflicts with the base". Solus already has
  // an agent for that, so the row becomes the resolver instead of a dead merge.
  if (detail.mergeStateStatus === 'dirty')
    return { kind: 'resolve-conflicts', label: 'Resolve merge conflicts with agent' }
  if (checksState === 'failing' || detail.mergeStateStatus === 'unstable')
    return {
      kind: 'blocked',
      label: 'Checks need attention',
      reason: 'Fix failing checks before you merge.',
    }
  if (checksState === 'pending')
    return {
      kind: 'blocked',
      label: 'Checks in progress',
      reason: 'Wait for checks to finish before you merge.',
    }
  if (checksState === 'unavailable')
    return {
      kind: 'blocked',
      label: 'Checks unavailable',
      reason: 'Refresh the checks before you merge.',
    }
  if (detail.mergeStateStatus === 'behind')
    return {
      kind: 'blocked',
      label: 'Branch is out of date',
      reason: `Update this branch with ${detail.baseRef ?? 'main'} before you merge.`,
    }
  if (detail.mergeStateStatus === 'blocked')
    return {
      kind: 'blocked',
      label: 'Merge requirements pending',
      reason: 'Complete the remaining code-host requirements before you merge.',
    }
  if (
    detail.mergeable !== true ||
    (detail.mergeStateStatus !== 'clean' && detail.mergeStateStatus !== 'has_hooks')
  )
    return {
      kind: 'blocked',
      label: 'Merge status pending',
      reason: 'The code host is calculating merge readiness.',
    }
  const method = defaultMergeMethod(methods)
  return { kind: 'merge', label: mergeActionLabel(method), method }
}
