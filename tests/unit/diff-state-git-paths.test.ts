import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { DiffState as DiffStateClass } from '@solus/workspace-ui/lib/diff-state.svelte'
import { clearPatchMetadataCache, parsePatchMetadata } from '@solus/workspace-ui/lib/pierre-diff/metadata'
import { hunkToPatch } from '@solus/workspace-ui/components/pr-review/lib/activity-data'

// Git quotes `café menu.ts` as `"a/caf\303\251 menu.ts"`. The host sends the
// real path for review comments, viewed files, and file stats, so the Diff tab
// must name the file with the real path too, or nothing matches it.
const HOST_PATH = 'café menu.ts'
const QUOTED = 'caf\\303\\251 menu.ts'
const QUOTED_PATCH = `diff --git "a/${QUOTED}" "b/${QUOTED}"
index 1111111..2222222 100644
--- "a/${QUOTED}"
+++ "b/${QUOTED}"
@@ -1 +1 @@
-before
+after
`
const RENAME_PATCH = `diff --git "a/old ${QUOTED}" b/new.ts
similarity index 90%
rename from "old ${QUOTED}"
rename to new.ts
--- "a/old ${QUOTED}"
+++ b/new.ts
@@ -1 +1 @@
-before
+after
`
const BINARY_PATCH = `diff --git "a/${QUOTED}.png" "b/${QUOTED}.png"
index 1111111..2222222 100644
Binary files "a/${QUOTED}.png" and "b/${QUOTED}.png" differ
`

type GlobalWithState = { $state?: unknown }
const previousState = (globalThis as GlobalWithState).$state
let DiffState: typeof DiffStateClass

beforeAll(async () => {
  ;(globalThis as GlobalWithState).$state = Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value })
  ;({ DiffState } = await import('@solus/workspace-ui/lib/diff-state.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as GlobalWithState).$state
  else (globalThis as GlobalWithState).$state = previousState
})

function diffStateFor(patch: string): DiffStateClass {
  const state = new DiffState({ session: {} as never, getTabId: () => 'tab' })
  state.setPatch({ kind: 'session' }, patch)
  return state
}

describe('Diff tab paths', () => {
  test('a quoted non-ASCII path comes out as the host path', () => {
    const state = diffStateFor(QUOTED_PATCH)
    expect(state.fileDiffs.map((file) => file.name)).toEqual([HOST_PATH])
  })

  test('a quoted rename source comes out as the host path, without quotes', () => {
    const state = diffStateFor(RENAME_PATCH)
    expect(state.fileDiffs[0]?.prevName).toBe(`old ${HOST_PATH}`)
    expect(state.fileDiffs[0]?.name).toBe('new.ts')
  })

  test('a quoted binary file is found by its host path', () => {
    const state = diffStateFor(BINARY_PATCH)
    expect(state.isBinaryFile(`${HOST_PATH}.png`)).toBe(true)
  })

  test('the cached single-file parse gives the host path', () => {
    clearPatchMetadataCache()
    expect(parsePatchMetadata(QUOTED_PATCH)?.name).toBe(HOST_PATH)
    // The second read comes from the cache and is not decoded again.
    expect(parsePatchMetadata(QUOTED_PATCH)?.name).toBe(HOST_PATH)
  })

  test('a thread preview for a path with a backslash keeps the path', () => {
    const path = 'dir\\file.ts'
    expect(parsePatchMetadata(hunkToPatch(path, '@@ -1 +1 @@\n-a\n+b'))?.name).toBe(path)
  })
})
