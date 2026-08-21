import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'

/**
 * Rebase a partial diff's hunk row offsets into the renderer's compact space.
 *
 * @pierre/diffs parses a patch into *source-file* row coordinates: a hunk's
 * `unifiedLineStart` counts every unchanged line before it, so a one-hunk edit
 * at line 1019 reports `unifiedLineStart: 1018` and the file reports a
 * thousand-row `unifiedLineCount`. Its virtualizer walks a *partial* diff as
 * compact rows instead — a collapsed gap is one separator row, not N rows
 * (`VirtualizedFileDiff.getExpandedLineCount` takes that branch whenever
 * `isPartial`) — yet `getLayoutLineCount` still maxes the row total against the
 * source-coordinate `unifiedLineCount`. The render window is then seeded in one
 * space and mapped back through `hunk.unifiedLineStart` in the other, so
 * `iterateOverDiff` emits rows with no line behind either side and the renderer
 * throws "deletionLine and additionLine are null, something is wrong".
 *
 * `collapsedBefore` stays untouched: it still describes the real gap, which is
 * what the "N unchanged lines" separator reads and what expansion requests.
 * Hydration (`hydratePartialDiff`) rebuilds hunks in source coordinates and
 * clears `isPartial`, moving the library to its gap-aware branch — so this
 * normalization applies only while a diff is still partial, and re-applying it
 * to a hydrated diff is a no-op.
 */
export function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file

  let splitLineStart = 0
  let unifiedLineStart = 0
  const hunks = file.hunks.map((hunk) => {
    const compacted = { ...hunk, splitLineStart, unifiedLineStart }
    splitLineStart += hunk.splitLineCount
    unifiedLineStart += hunk.unifiedLineCount
    return compacted
  })

  const compacted: FileDiffMetadata = {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
  }
  // Any edit to the content or coordinates needs its own key, or @pierre's
  // worker pool serves the highlight it cached for the source-coordinate shape.
  if (file.cacheKey) compacted.cacheKey = `${file.cacheKey}:compact-partial`
  return compacted
}

/**
 * Drop whole hunks from a parsed diff, keeping the survivors' line arrays and
 * row offsets consistent with each other (see `compactPartialHunkOffsets` for
 * why that consistency is load-bearing).
 *
 * The result is marked partial because the omitted regions are no longer in the
 * compacted line arrays, so the renderer must not try to expand a gap from them;
 * `isPartial` is what disables that inline expansion.
 */
export function collapseHunks(
  file: FileDiffMetadata,
  omittedHunkIndexes: readonly number[],
): FileDiffMetadata {
  if (omittedHunkIndexes.length === 0) return file
  const omitted = new Set(omittedHunkIndexes)

  const additionLines: string[] = []
  const deletionLines: string[] = []
  const hunks = file.hunks
    .filter((_, index) => !omitted.has(index))
    .map((hunk) => {
      const additionLineIndex = additionLines.length
      const deletionLineIndex = deletionLines.length
      additionLines.push(
        ...file.additionLines.slice(
          hunk.additionLineIndex,
          hunk.additionLineIndex + hunk.additionCount,
        ),
      )
      deletionLines.push(
        ...file.deletionLines.slice(
          hunk.deletionLineIndex,
          hunk.deletionLineIndex + hunk.deletionCount,
        ),
      )
      return {
        ...hunk,
        additionLineIndex,
        deletionLineIndex,
        hunkContent: hunk.hunkContent.map((content) => ({
          ...content,
          additionLineIndex:
            additionLineIndex + content.additionLineIndex - hunk.additionLineIndex,
          deletionLineIndex:
            deletionLineIndex + content.deletionLineIndex - hunk.deletionLineIndex,
        })),
      }
    })

  return compactPartialHunkOffsets({
    ...file,
    hunks,
    additionLines,
    deletionLines,
    isPartial: true,
    cacheKey: file.cacheKey ? `${file.cacheKey}:collapsed-${omittedHunkIndexes.join('-')}` : undefined,
  })
}

// Parsing a unified patch into pierre's FileDiffMetadata is pure but hot: the
// diff stream rebuilds its structural items — re-parsing every file's patch —
// on initial load, every live mid-turn refresh, and theme/style toggles.
// Memoize on the raw patch string so unchanged files are parsed once and reused;
// a live refresh that touches one file no longer re-parses the other N-1.
//
// IMPORTANT: hand out a fresh top-level object each call rather than the cached
// instance itself. We call parsePatchFiles without a cacheKeyPrefix, so the
// metadata's `cacheKey` is undefined, which makes @pierre's areDiffTargetsEqual
// fall back to *reference* equality. @pierre reuses its per-file layout cache
// (which holds the header +/- counts) whenever that reference is unchanged, so
// returning the same instance on re-render drops the counts. A shallow copy
// keeps a distinct reference (forcing @pierre to refresh the target, as it did
// before memoization) while still reusing the cached hunk arrays — the
// expensive part. @pierre never mutates the metadata, so sharing the nested
// hunks is safe.
const patchCache = new Map<string, FileDiffMetadata | null>()
const PATCH_CACHE_LIMIT = 400
const PATCH_CACHE_SOURCE_BYTES = 8 * 1024 * 1024
const PATCH_CACHE_MAX_ENTRY_BYTES = 512 * 1024
let patchCacheSourceBytes = 0

function sourceBytes(patch: string): number {
  // V8 may store Latin-1 strings compactly, but two bytes/code-unit is the
  // conservative retained-size bound for arbitrary Unicode patches.
  return patch.length * 2
}

function cacheParsedPatch(patch: string, parsed: FileDiffMetadata | null): void {
  const bytes = sourceBytes(patch)
  // A single generated/vendor diff can be tens of megabytes. Keeping it as a
  // Map key plus Pierre's parsed hunk graph turns a one-off view into a
  // renderer-lifetime memory charge, so large entries deliberately bypass the
  // cache and become collectible with their surface.
  if (bytes > PATCH_CACHE_MAX_ENTRY_BYTES) return
  while (patchCache.size >= PATCH_CACHE_LIMIT || patchCacheSourceBytes + bytes > PATCH_CACHE_SOURCE_BYTES) {
    const oldest = patchCache.keys().next().value
    if (oldest === undefined) break
    patchCache.delete(oldest)
    patchCacheSourceBytes -= sourceBytes(oldest)
  }
  patchCache.set(patch, parsed)
  patchCacheSourceBytes += bytes
}

export function clearPatchMetadataCache(): void {
  patchCache.clear()
  patchCacheSourceBytes = 0
}

export interface PatchMetadataCacheStats { entries: number; sourceBytes: number }

export function patchMetadataCacheStats(): PatchMetadataCacheStats {
  return { entries: patchCache.size, sourceBytes: patchCacheSourceBytes }
}

/**
 * Parse a single-file patch into renderer-ready metadata. Every diff surface
 * reads its files through here (or through `compactPartialHunkOffsets` on a
 * chunk-cached parse), so the whole app hands @pierre one row coordinate space.
 */
export function parsePatchMetadata(patchStr: string): FileDiffMetadata | null {
  let parsed = patchCache.get(patchStr)
  if (parsed === undefined) {
    try {
      const file = parsePatchFiles(patchStr)[0]?.files[0]
      parsed = file ? compactPartialHunkOffsets(file) : null
    } catch {
      parsed = null
    }
    // FIFO eviction keeps the cache bounded; the working set (files in one diff)
    // is far below the limit, so eviction only trims long-replaced patches.
    cacheParsedPatch(patchStr, parsed)
  }
  return parsed ? { ...parsed } : null
}
