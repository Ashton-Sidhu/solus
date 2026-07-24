import { describe, expect, test } from 'bun:test'
import { processFile, type FileDiffMetadata } from '@pierre/diffs'
import {
  buildExpandableMetadata,
  fileVersionsFromFullContext,
} from '../../src/renderer/lib/diff-expandable'

// A file whose middle is untouched: `git diff -U3` leaves a gap the reviewer
// can't see, and `git diff -U1000000` is the same change with the whole file
// as context.
const OLD_FILE = [
  'const a = 1',
  'const b = 2',
  'const c = 3',
  'const d = 4',
  'const e = 5',
  'const f = 6',
  'const g = 7',
  'const h = 8',
  'const i = 9',
].join('\n') + '\n'

const PATCH = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
-const a = 1
+const a = 100
 const b = 2
@@ -8,2 +8,2 @@
 const h = 8
-const i = 9
+const i = 900
`

const FULL_CONTEXT_PATCH = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,9 +1,9 @@
-const a = 1
+const a = 100
 const b = 2
 const c = 3
 const d = 4
 const e = 5
 const f = 6
 const g = 7
 const h = 8
-const i = 9
+const i = 900
`

function parse(patch: string): FileDiffMetadata {
  const file = processFile(patch, { isGitDiff: true })
  if (!file) throw new Error('failed to parse fixture patch')
  return file
}

/** The line/number sequence the diff panel reads for find-in-diff, comment
 *  anchoring and moved-block analysis. */
function walk(file: FileDiffMetadata): string[] {
  const out: string[] = []
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines; i++) {
          out.push(`${oldLine++}/${newLine++} ${file.additionLines[content.additionLineIndex + i]}`)
        }
      } else {
        for (let i = 0; i < content.deletions; i++) {
          out.push(`${oldLine++}/- ${file.deletionLines[content.deletionLineIndex + i]}`)
        }
        for (let i = 0; i < content.additions; i++) {
          out.push(`-/${newLine++} ${file.additionLines[content.additionLineIndex + i]}`)
        }
      }
    }
  }
  return out
}

describe('expandable hunk gaps', () => {
  test('a full-context patch round-trips into the file contents it was built from', () => {
    const versions = fileVersionsFromFullContext(parse(FULL_CONTEXT_PATCH))

    expect(versions?.oldContents).toBe(OLD_FILE)
    expect(versions?.newContents).toBe(OLD_FILE.replace('const a = 1\n', 'const a = 100\n').replace('const i = 9\n', 'const i = 900\n'))
  })

  test('rebuilding against those contents makes the gap expandable without changing what the panel reads', () => {
    const partial = parse(PATCH)
    const versions = fileVersionsFromFullContext(parse(FULL_CONTEXT_PATCH))!

    const expandable = buildExpandableMetadata(PATCH, partial, versions)

    // Non-partial metadata is what unlocks expansion in @pierre/diffs, and the
    // gap it can expand into is the 5 untouched lines between the two hunks.
    expect(expandable?.isPartial).toBe(false)
    expect(expandable?.hunks.map((hunk) => hunk.collapsedBefore)).toEqual([0, 5])
    // Everything downstream still sees git's hunks, line for line.
    expect(walk(expandable!)).toEqual(walk(partial))
  })

  test('contents that no longer match the patch are rejected, so a stale working tree cannot mis-render the diff', () => {
    const partial = parse(PATCH)
    const versions = fileVersionsFromFullContext(parse(FULL_CONTEXT_PATCH))!

    // The file grew after the patch was taken: the trailing context no longer
    // lines up on both sides, which is what makes the library throw.
    const stale = { ...versions, newContents: `${versions.newContents}const j = 10\n` }

    expect(buildExpandableMetadata(PATCH, partial, stale)).toBeNull()
  })
})
