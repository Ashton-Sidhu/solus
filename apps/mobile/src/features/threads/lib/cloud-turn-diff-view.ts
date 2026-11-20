import type { CloudTurnDiffState } from '../cloud-history'
import { sessionTurnDiffText } from '@solus/client-core/session-cloud-read-text'

/**
 * What the diff screen of a turn from Solus Cloud shows
 * (docs/plans/portable-sessions-cloud.md, Phase 5B): the patch on the diff
 * surface, a spinner, or an honest statement of why there is no patch.
 */
export type CloudTurnDiffView =
  | { kind: 'loading' }
  | { kind: 'patch'; patch: string }
  | { kind: 'message'; title: string; detail: string; canRetry: boolean }

export function cloudTurnDiffView(state: CloudTurnDiffState): CloudTurnDiffView {
  if (state.kind === 'idle' || state.kind === 'loading') return { kind: 'loading' }
  if (state.kind === 'error') return { kind: 'message', title: sessionTurnDiffText({ status: 'error' })!, detail: state.message, canRetry: true }
  const { diff } = state
  switch (diff.status) {
    case 'available':
      return diff.patch.trim()
        ? { kind: 'patch', patch: diff.patch }
        : { kind: 'message', title: 'No changes', detail: sessionTurnDiffText({ status: 'no-change' })!, canRetry: false }
    case 'too-large': {
      return {
        kind: 'message',
        title: 'Too large to show here',
        detail: sessionTurnDiffText(diff)!,
        canRetry: false,
      }
    }
    case 'not-available':
      return { kind: 'message', title: 'Not in Solus Cloud', detail: sessionTurnDiffText(diff)!, canRetry: false }
  }
}
