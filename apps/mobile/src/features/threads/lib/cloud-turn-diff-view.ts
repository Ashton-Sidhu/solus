import type { CloudTurnDiffState } from '../cloud-history'

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
  if (state.kind === 'error') return { kind: 'message', title: 'The changes could not be read', detail: state.message, canRetry: true }
  const { diff } = state
  switch (diff.status) {
    case 'available':
      return diff.patch.trim()
        ? { kind: 'patch', patch: diff.patch }
        : { kind: 'message', title: 'No changes', detail: 'This turn changed no files.', canRetry: false }
    case 'too-large': {
      const files = diff.filesChanged === 1 ? '1 file' : `${diff.filesChanged} files`
      return {
        kind: 'message',
        title: 'Too large to show here',
        detail: `This turn changed ${files}, +${diff.additions} −${diff.deletions}. Open the session on a host to see the changes.`,
        canRetry: false,
      }
    }
    case 'not-available':
      return { kind: 'message', title: 'Not in Solus Cloud', detail: 'Solus Cloud has no changes for this turn. Open the session on a host to see them.', canRetry: false }
  }
}
