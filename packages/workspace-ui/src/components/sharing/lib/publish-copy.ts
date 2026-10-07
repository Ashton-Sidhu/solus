import type { PublishOutcome, PublishStatus } from '../../../contexts/sharing/shares.store.svelte'

/**
 * The words for an upload that did not finish (cloud-sharing.md §3), one
 * sentence per state, shared by the dialog and the Copy link toast.
 */
export function publishProblemMessage(status: PublishStatus | PublishOutcome, kind: string, organizationName: string): string | null {
  switch (status.kind) {
    case 'offline':
      return `The computer that holds this ${kind} is not connected. Connect it and try again.`
    case 'failed':
      return status.error
    case 'denied':
      return `You cannot publish to ${organizationName}. ${status.error}`.trim()
    default:
      return null
  }
}
