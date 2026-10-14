import type { GuideAttentionKind } from '@solus/contracts/review'
import { patchFileChunks } from '../../../../lib/pierre-diff'

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
 * post-image path, which matches `GuideFileRef.path`. Each segment is itself a
 * valid single-file unified diff that `GuideFileDiff.svelte` can render. The
 * parser names each file, so a quoted path, a rename, and a path that contains
 * ` b/` get their real names.
 */
export function splitPatchByFile(patch: string): Map<string, string> {
  return new Map(patchFileChunks(patch).map((file) => [file.path, file.text]))
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
