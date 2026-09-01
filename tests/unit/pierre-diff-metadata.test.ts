import { describe, expect, test } from 'bun:test'
import { hydratePartialDiff, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import {
  collapseHunks,
  compactPartialHunkOffsets,
  parsePatchMetadata,
  patchCacheKey,
} from '@solus/workspace-ui/lib/pierre-diff/metadata'

const TWO_HUNK_PATCH = `diff --git a/example.ts b/example.ts
index 1111111..2222222 100644
--- a/example.ts
+++ b/example.ts
@@ -48,4 +48,4 @@
 context
-before
+after
 context
 context
@@ -80,3 +80,4 @@
 context
+added
 context
 context
`

/**
 * Walk the metadata the way `iterateOverDiff` does — every rendered row reads
 * `additionLines`/`deletionLines` at the index its hunk content declares — and
 * report each row that has no line behind either side. Those are exactly the
 * rows @pierre/diffs refuses to render with "DiffHunksRenderer.processDiffResult:
 * deletionLine and additionLine are null, something is wrong".
 */
function unbackedRows(file: FileDiffMetadata): string[] {
  const missing: string[] = []
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    for (const content of hunk.hunkContent) {
      const rows =
        content.type === 'context'
          ? content.lines
          : Math.max(content.additions, content.deletions)
      for (let row = 0; row < rows; row++) {
        const hasDeletion =
          (content.type === 'context' || row < content.deletions) &&
          file.deletionLines[content.deletionLineIndex + row] !== undefined
        const hasAddition =
          (content.type === 'context' || row < content.additions) &&
          file.additionLines[content.additionLineIndex + row] !== undefined
        if (!hasDeletion && !hasAddition) missing.push(`hunk ${hunkIndex} row ${row}`)
      }
    }
  }
  return missing
}

function rowSpace(file: FileDiffMetadata) {
  let walkedTotal = 0
  const starts: number[] = []
  for (const hunk of file.hunks) {
    starts.push(hunk.unifiedLineStart)
    walkedTotal += hunk.unifiedLineCount
  }
  return { starts, declaredTotal: file.unifiedLineCount, walkedTotal }
}

describe('pierre diff metadata', () => {
  test('a partial patch reports hunk rows in the compact space the virtualizer walks, not source-file coordinates', () => {
    // @pierre/diffs walks a partial diff as compact rows — a collapsed gap is one
    // separator, not one row per unchanged line — but parses hunk starts in
    // source-file coordinates. Handing it the parsed values makes its render
    // window land on rows no hunk owns, which is the null-line render crash.
    const file = parsePatchMetadata(TWO_HUNK_PATCH)
    expect(file).not.toBeNull()
    if (!file) return

    const { starts, declaredTotal, walkedTotal } = rowSpace(file)
    expect(starts[0]).toBe(0)
    expect(starts[1]).toBe(file.hunks[0].unifiedLineCount)
    expect(declaredTotal).toBe(walkedTotal)
  })

  test('compacting keeps the gap sizes and line numbers a reader sees', () => {
    const [raw] = parsePatchFiles(TWO_HUNK_PATCH).flatMap((part) => part.files)
    const file = compactPartialHunkOffsets(raw)

    // `collapsedBefore` still describes the real gap, so the "N unchanged lines"
    // separator and any expansion request stay truthful.
    expect(file.hunks.map((hunk) => hunk.collapsedBefore)).toEqual(
      raw.hunks.map((hunk) => hunk.collapsedBefore),
    )
    expect(file.hunks.map((hunk) => hunk.additionStart)).toEqual([48, 80])
    expect(file.hunks.map((hunk) => hunk.deletionStart)).toEqual([48, 80])
  })

  test('a hydrated diff is left in source-file coordinates because the library switches to its gap-aware model', () => {
    const [raw] = parsePatchFiles(TWO_HUNK_PATCH).flatMap((part) => part.files)
    const hydrated: FileDiffMetadata = { ...raw, isPartial: false }

    expect(compactPartialHunkOffsets(hydrated)).toBe(hydrated)
  })

  test('dropping a hunk leaves every surviving row backed by a line, so the renderer never sees an empty row', () => {
    const [raw] = parsePatchFiles(TWO_HUNK_PATCH).flatMap((part) => part.files)

    const collapsed = collapseHunks(compactPartialHunkOffsets(raw), [0])

    expect(collapsed.hunks).toHaveLength(1)
    expect(unbackedRows(collapsed)).toEqual([])
    // The dropped hunk's regions are gone from the line arrays, so inline
    // expansion must stay off for this view.
    expect(collapsed.isPartial).toBe(true)
  })

  test('two shapes of one file at one revision pair hydrate to different cache keys', () => {
    // @pierre keys its worker AST cache by cacheKey alone, and an unkeyed diff
    // hydrates to `${oldFile.cacheKey}:${newFile.cacheKey}` — a path and a
    // revision, which says nothing about the hunks. Both shapes below would then
    // share one cached AST, and the renderer would walk one shape's rows against
    // the other's rendered lines: "deletionLine and additionLine are null".
    const loaded = {
      oldFile: { name: 'example.ts', contents: 'x\n'.repeat(90), cacheKey: 'base:example.ts' },
      newFile: { name: 'example.ts', contents: 'x\n'.repeat(90), cacheKey: 'head:example.ts' },
    }
    const file = parsePatchMetadata(TWO_HUNK_PATCH)
    expect(file?.cacheKey).toBeDefined()
    if (!file) return
    const collapsed = collapseHunks(file, [0])

    const hydratedFull = hydratePartialDiff('clone', file, loaded)
    const hydratedCollapsed = hydratePartialDiff('clone', collapsed, loaded)

    expect(hydratedFull.cacheKey).toBeDefined()
    expect(hydratedFull.cacheKey).not.toBe(hydratedCollapsed.cacheKey)
  })

  test('the cache key tracks patch content, so an edited patch never reuses a rendered diff', () => {
    const edited = TWO_HUNK_PATCH.replace('+added', '+something else')

    expect(patchCacheKey(TWO_HUNK_PATCH)).toBe(patchCacheKey(TWO_HUNK_PATCH))
    expect(patchCacheKey(TWO_HUNK_PATCH)).not.toBe(patchCacheKey(edited))
  })

  test('dropping a hunk keeps the compact row contract the virtualizer relies on', () => {
    const [raw] = parsePatchFiles(TWO_HUNK_PATCH).flatMap((part) => part.files)

    const { starts, declaredTotal, walkedTotal } = rowSpace(
      collapseHunks(compactPartialHunkOffsets(raw), [0]),
    )

    expect(starts).toEqual([0])
    expect(declaredTotal).toBe(walkedTotal)
  })
})
