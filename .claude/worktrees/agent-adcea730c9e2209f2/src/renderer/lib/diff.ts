import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'

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

export function parsePatchMetadata(patchStr: string): FileDiffMetadata | null {
  let parsed = patchCache.get(patchStr)
  if (parsed === undefined) {
    try {
      parsed = parsePatchFiles(patchStr)[0]?.files[0] ?? null
    } catch {
      parsed = null
    }
    // FIFO eviction keeps the cache bounded; the working set (files in one diff)
    // is far below the limit, so eviction only trims long-replaced patches.
    if (patchCache.size >= PATCH_CACHE_LIMIT) {
      const oldest = patchCache.keys().next().value
      if (oldest !== undefined) patchCache.delete(oldest)
    }
    patchCache.set(patchStr, parsed)
  }
  return parsed ? { ...parsed } : null
}
