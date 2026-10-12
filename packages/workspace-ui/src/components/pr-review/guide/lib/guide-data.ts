import type { GuideAttentionKind } from '@solus/contracts/review'

// Private logic for the native Guide renderer: turning the whole-episode patch
// into the per-file segments each section embeds, and naming the decision a
// section asks for.

/**
 * Payload emitted when a reviewer saves a comment on a guide diff. Mirrors the
 * Diff tab's save shape (`DiffPanel`'s `ExternalDiffCommentSave`) so guide
 * comments flow into the same review-draft store. `id` is set when editing an
 * existing draft; `selectedCode` is unused by the PR-review store but kept for
 * shape parity.
 */
export type GuideDiffCommentSave = {
  id?: string
  filePath: string
  startLine: number
  endLine: number
  side: 'old' | 'new'
  selectedCode: string
  comment: string
  createdAt?: number
}

/**
 * Split a multi-file unified diff into per-file patch segments keyed by the
 * post-image path (`b/…`), which matches `GuideFileRef.path`. Each segment is
 * itself a valid single-file unified diff that `GuideFileDiff.svelte` can render. A file
 * begins at its `diff --git` header and runs until the next one. (quotepath is
 * off upstream, so paths are unquoted.)
 */
export function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!patch) return map

  let current: string[] | null = null
  let currentPath: string | null = null
  const flush = () => {
    if (currentPath && current) map.set(currentPath, current.join('\n'))
  }

  for (const line of patch.split('\n')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (m) {
      flush()
      currentPath = m[2]
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  flush()
  return map
}

const ATTENTION_LABELS = {
  tradeoff: 'A tradeoff to weigh',
  contract: 'A contract that changes',
  product: 'A product decision',
  risk: 'A risk to accept',
  accessibility: 'An accessibility effect',
} satisfies Record<GuideAttentionKind, string>

/** The heading of a section's attention callout. */
export function attentionLabel(kind: GuideAttentionKind): string {
  return ATTENTION_LABELS[kind]
}
