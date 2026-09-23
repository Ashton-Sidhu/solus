/**
 * Queue review guides for the checked pull requests, in the background, and
 * say what happened. Guides no longer generate on their own; this is the one
 * way the list asks for a batch, so they are ready by the time each review
 * opens. The host-ready event owns the success toast and its guide action.
 */
import type { PrGuidesStore } from '../../../contexts/prs/pr-guides.store.svelte'
import { toasts } from '../../../lib/toasts'
import type { PrTarget } from './pr-cross-project'

export function queueReviewGuides(
  guides: PrGuidesStore,
  target: PrTarget,
  numbers: number[],
  onView: () => void,
): void {
  if (numbers.length === 0) return
  toasts.info(
    numbers.length === 1
      ? `Started generating the review guide for PR #${numbers[0]}`
      : `Started generating ${numbers.length} review guides`,
  )
  void guides
    .request(target.api, target.serverId, target.ctx, numbers, {
      onSettled: ({ total, failed }) => {
        if (failed === 0) return
        toasts.error(
          failed === total
            ? `Couldn't generate ${total === 1 ? 'the review guide' : `${total} review guides`}`
            : `${total - failed} of ${total} review guides ready; ${failed} failed`,
          { action: { label: 'View', onAction: onView } },
        )
      },
    })
    .catch((error) => {
      toasts.error("Couldn't queue review guides", {
        description: error instanceof Error ? error.message : String(error),
      })
    })
}
