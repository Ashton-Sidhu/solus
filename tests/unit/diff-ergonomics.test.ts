import { describe, expect, test } from 'bun:test'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import { detectMovedBlocks } from '../../src/renderer/lib/diff-moves'
import {
  analyzeDiffNoise,
  collapseFormatOnlyHunks,
  isFormatOnlyHunk,
} from '../../src/renderer/lib/diff-noise'
import { orderDiffFiles } from '../../src/renderer/lib/diff-order'

function parse(patch: string): FileDiffMetadata[] {
  return parsePatchFiles(patch).flatMap((part) => part.files)
}

describe('diff-reading ergonomics', () => {
  test('a moved-unchanged block is detected within a file because the reviewer already read it at its origin', () => {
    const files = parse(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,7 +1,7 @@
-function total(values: number[]) {
-  return values.reduce((sum, value) => sum + value, 0)
-}
-
 const label = 'Total'
+function total(values: number[]) {
+  return values.reduce((sum, value) => sum + value, 0)
+}
+
 export { label }
`)

    const analysis = detectMovedBlocks(files)

    expect(analysis.moves).toHaveLength(1)
    expect(analysis.moves[0].kind).toBe('unchanged')
    expect(analysis.moves[0].origin.filePath).toBe('src/example.ts')
    expect(analysis.moves[0].destination.filePath).toBe('src/example.ts')
  })

  test('a moved block is matched across files so a file split does not look like duplicate deletion and addition', () => {
    const files = parse(`diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function total(values: number[]) {
-  return values.reduce((sum, value) => sum + value, 0)
-}
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function total(values: number[]) {
+  return values.reduce((sum, value) => sum + value, 0)
+}
`)

    const analysis = detectMovedBlocks(files)

    expect(analysis.moves).toHaveLength(1)
    expect(analysis.moves[0].origin.filePath).toBe('src/old.ts')
    expect(analysis.moves[0].destination.filePath).toBe('src/new.ts')
  })

  test('a moved-and-modified block records only intra-move edits so unchanged lines stay de-emphasized', () => {
    const files = parse(`diff --git a/src/old.ts b/src/old.ts
--- a/src/old.ts
+++ /dev/null
@@ -1,4 +0,0 @@
-export function total(values: number[]) {
-  const initial = 0
-  return values.reduce((sum, value) => sum + value, initial)
-}
diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,4 @@
+export function total(values: number[]) {
+  const initial = 10
+  return values.reduce((sum, value) => sum + value, initial)
+}
`)

    const [move] = detectMovedBlocks(files).moves

    expect(move.kind).toBe('modified')
    expect(move.unchangedLineCount).toBe(3)
    expect(move.edits).toHaveLength(1)
    expect(move.edits[0].deletionRanges).toEqual([])
    expect(move.edits[0].additionRanges).toEqual([{ start: 18, length: 1 }])
  })

  test('a lockfile collapses with the real changed-line count so review scope remains honest', () => {
    const [file] = parse(`diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1,2 +1,3 @@
 package-a@1.0.0
-checksum-old
+checksum-new
+package-b@1.0.0
`)

    expect(analyzeDiffNoise(file)).toMatchObject({
      kind: 'lockfile',
      lineCount: 3,
      autoCollapse: true,
    })
  })

  test('a whitespace-only hunk collapses because formatting carries no behavioral review signal', () => {
    const [file] = parse(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
-if (ready) {
-  run()
+if(ready){
+    run()
`)

    expect(isFormatOnlyHunk(file, file.hunks[0])).toBe(true)
    expect(analyzeDiffNoise(file)).toMatchObject({
      kind: 'format-only',
      formatOnlyLineCount: 4,
    })
  })

  test('a format-only hunk collapses without hiding a behavioral hunk in the same file', () => {
    const [file] = parse(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-const answer=42
+const answer = 42
@@ -10 +10 @@
-runLegacy()
+runCurrent()
`)

    const visible = collapseFormatOnlyHunks(file)

    expect(visible.hunks).toHaveLength(1)
    expect(visible.additionLines[visible.hunks[0].additionLineIndex].trim()).toBe('runCurrent()')
  })

  test('narrative ordering leads with entry points, then tests, then configuration', () => {
    const files = [
      { name: 'vite.config.ts' },
      { name: 'src/parser.ts' },
      { name: 'src/parser.test.ts' },
      { name: 'src/main.ts' },
      { name: 'src/index.test.ts' },
    ] as FileDiffMetadata[]

    expect(orderDiffFiles(files).map((file) => file.name)).toEqual([
      'src/main.ts',
      'src/parser.ts',
      'src/parser.test.ts',
      'src/index.test.ts',
      'vite.config.ts',
    ])
  })
})
