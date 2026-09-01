import { describe, expect, test } from 'bun:test'
import { hydratePartialDiff, processFile, type FileDiffMetadata } from '@pierre/diffs'
import { loadDiffFiles } from '@solus/workspace-ui/lib/diff-file-loader'
import type {
  DiffFileContentsRequest,
  DiffFileContentsResult,
  IpcContext,
} from '@solus/contracts/types'

const ctx = {} as IpcContext

function parse(patch: string): FileDiffMetadata {
  const file = processFile(patch, { isGitDiff: true })
  if (!file) throw new Error('failed to parse fixture patch')
  return file
}

describe('lazy diff file loader', () => {
  test('requests the exact patch endpoints so hydration cannot mix diff generations', async () => {
    const fileDiff = parse(`diff --git a/src/file.ts b/src/file.ts
index 1111111..2222222 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1 +1 @@
-old
+new
`)
    let request: DiffFileContentsRequest | undefined
    const result: DiffFileContentsResult = {
      oldFile: { name: 'src/file.ts', contents: 'old\n', cacheKey: '1111111111' },
      newFile: { name: 'src/file.ts', contents: 'new\n', cacheKey: '2222222222' },
    }

    const loaded = await loadDiffFiles(
      {
        diffFileContents: async (_ctx, nextRequest) => {
          request = nextRequest
          return result
        },
      },
      ctx,
      { kind: 'working-tree' },
      fileDiff,
      ['src/file.ts'],
    )

    expect(request).toEqual({
      scope: { kind: 'working-tree' },
      path: 'src/file.ts',
      previousPath: undefined,
      livePaths: ['src/file.ts'],
      expectedOldObjectId: '1111111',
      expectedNewObjectId: '2222222',
    })
    expect(loaded).toEqual(result)
    const hydrated = hydratePartialDiff('clone', fileDiff, loaded)
    expect(hydrated.isPartial).toBe(false)
    expect(hydrated.deletionLines.join('')).toBe('old\n')
    expect(hydrated.additionLines.join('')).toBe('new\n')
  })

  test('uses the library pure-rename contract while retaining the destination content', async () => {
    const fileDiff = parse(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`)
    const newFile = { name: 'new.ts', contents: 'same\n', cacheKey: 'blob-id' }

    const loaded = await loadDiffFiles(
      {
        diffFileContents: async () => ({
          oldFile: { name: 'old.ts', contents: 'same\n', cacheKey: 'blob-id' },
          newFile,
        }),
      },
      ctx,
      { kind: 'pr', baseSha: 'base' },
      fileDiff,
    )

    expect(loaded).toEqual({ oldFile: null, newFile })
  })

  test('rejects missing content so @pierre/diffs keeps the partial patch intact', async () => {
    const fileDiff = parse(`diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1 +1 @@
-old
+new
`)

    expect(loadDiffFiles(
      { diffFileContents: async () => null },
      ctx,
      { kind: 'working-tree' },
      fileDiff,
    )).rejects.toThrow('Full contents are unavailable')
  })
})
