import { processFile, type FileDiffMetadata } from '@pierre/diffs'

// Hunk-gap expansion in @pierre/diffs is gated on `FileDiffMetadata.isPartial`
// being false: expanding reads lines out of `additionLines` / `deletionLines` at
// absolute file indices, so those arrays must hold the *whole* file, not just
// the patched lines. Re-running the same `git diff` with a huge `--unified`
// gives us exactly that — one hunk per file spanning the entire file, whose
// parsed line arrays join back into the original blobs (the parser keeps each
// line's newline and honours `\ No newline at end of file`). Re-parsing the
// *normal* chunk against those blobs keeps git's own hunk boundaries — and with
// them moved-block analysis, noise analysis and find-in-diff — byte-identical
// to the patch-only parse, and only adds the surrounding lines.

/** Both versions of one file, recovered from its full-context parse. */
export interface FileVersions {
  oldContents: string
  newContents: string
}

/**
 * Recover a file's old and new contents from its full-context parse. Null when
 * that parse isn't actually whole-file — a binary or mode-only change has no
 * hunk, and anything past `FULL_CONTEXT_LINES` lines would be split across
 * several, leaving the line arrays with holes.
 */
export function fileVersionsFromFullContext(fullContext: FileDiffMetadata): FileVersions | null {
  if (fullContext.hunks.length !== 1) return null
  return {
    oldContents: fullContext.deletionLines.join(''),
    newContents: fullContext.additionLines.join(''),
  }
}

/**
 * Rebuild one file's metadata against its full contents so the unchanged gaps
 * between its hunks become expandable. `chunk` is a `diff --git` chunk for the
 * file — the whole-file one from the normal patch, or the concern-scoped subset
 * a review guide authored — and `partial` is that same chunk's patch-only parse.
 *
 * Returns null whenever the contents don't line up with the chunk: the patch and
 * the contents come from separate `git diff` runs, so a working tree edited in
 * between can desync them. Callers keep `partial` in that case, which just means
 * the file keeps today's non-expandable separators.
 */
export function buildExpandableMetadata(
  chunk: string,
  partial: FileDiffMetadata,
  versions: FileVersions,
): FileDiffMetadata | null {
  let rebuilt: FileDiffMetadata | undefined
  try {
    rebuilt = processFile(chunk, {
      isGitDiff: true,
      oldFile: { name: partial.prevName ?? partial.name, contents: versions.oldContents },
      newFile: { name: partial.name, contents: versions.newContents },
    })
  } catch {
    return null
  }
  return rebuilt && isConsistent(partial, rebuilt) ? rebuilt : null
}

/**
 * The rebuilt metadata must describe the same change as the patch-only parse,
 * and its trailing context must be symmetric — that last condition is the
 * library's only throwing path on non-partial metadata
 * (`getTrailingContextRangeSize`), and it is exactly what a stale blob breaks.
 */
function isConsistent(partial: FileDiffMetadata, rebuilt: FileDiffMetadata): boolean {
  if (rebuilt.isPartial) return false
  if (partial.hunks.length !== rebuilt.hunks.length) return false
  const last = rebuilt.hunks[rebuilt.hunks.length - 1]
  if (!last) return false
  // A pure add or delete leaves one side empty, and the library skips its
  // trailing-context arithmetic entirely for those (there's nothing to expand
  // into on the missing side).
  if (rebuilt.additionLines.length === 0 || rebuilt.deletionLines.length === 0) return true
  const additionRemaining = rebuilt.additionLines.length - (last.additionLineIndex + last.additionCount)
  const deletionRemaining = rebuilt.deletionLines.length - (last.deletionLineIndex + last.deletionCount)
  return additionRemaining === deletionRemaining
}
