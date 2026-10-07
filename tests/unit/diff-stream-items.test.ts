import { describe, expect, test } from 'bun:test'
import { CodeView, parsePatchFiles, type CodeViewDiffItem, type FileDiffMetadata } from '@pierre/diffs'
import { structuralItemVersion } from '@solus/workspace-ui/components/diff/lib/diff-stream-items'

type Item = CodeViewDiffItem<never>
interface ItemRecord { type: 'diff'; item: Item; version: number | undefined }
// CodeView.setItems reuses a record by id and runs this check to decide
// whether the record takes the new item. Drive the library's own rule.
const syncItemRecord = (CodeView.prototype as unknown as {
  syncItemRecord(record: ItemRecord, next: Item): boolean
}).syncItemRecord

function parse(line: string): FileDiffMetadata {
  const [file] = parsePatchFiles(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+${line}
`).flatMap((patch) => patch.files)
  return file
}

function item(fileDiff: FileDiffMetadata, current: Item | undefined): Item {
  return { id: 'a.ts', type: 'diff', fileDiff, annotations: [], collapsed: false,
    version: structuralItemVersion(current, fileDiff, false) }
}

function record(first: Item): ItemRecord {
  return { type: 'diff', item: first, version: first.version }
}

describe('diff stream items', () => {
  test('a live refresh that edits a file replaces the content CodeView shows', () => {
    const shown = record(item(parse('first'), undefined))
    // Two refreshes: a file nobody commented on or collapsed must not go stale.
    for (const line of ['second', 'third']) {
      syncItemRecord.call(null, shown, item(parse(line), shown.item))
      expect(shown.item.fileDiff.additionLines).toEqual([`${line}\n`])
    }
  })

  test('a refresh that leaves a file untouched keeps its record, so CodeView does not re-render it', () => {
    const file = parse('same')
    const shown = record(item(file, undefined))
    expect(syncItemRecord.call(null, shown, item(file, shown.item))).toBe(false)
  })
})
