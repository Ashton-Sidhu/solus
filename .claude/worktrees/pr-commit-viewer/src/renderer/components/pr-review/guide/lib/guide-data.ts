import type { LedgerRecord } from '../../../../../shared/review'

// Private logic for the native Guide renderer: turning the whole-episode patch
// into the per-file segments each section embeds, and resolving a section's
// ledgerRefs back to the records that carry the deeper detail.

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

/**
 * Resolve a section's `ledgerRefs` (ids) to the records that hold the
 * why/assumptions/alternatives/edge-case detail. `normalizeGuide` already drops
 * unknown ids at write time, but we guard again so a stale cache never throws.
 */
export function resolveLedgerRefs(refs: string[], records: LedgerRecord[]): LedgerRecord[] {
  if (refs.length === 0) return []
  const byId = new Map(records.map((r) => [r.id, r]))
  return refs.map((id) => byId.get(id)).filter((r): r is LedgerRecord => !!r)
}
