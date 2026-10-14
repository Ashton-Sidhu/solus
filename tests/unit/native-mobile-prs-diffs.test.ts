import { describe, expect, test } from 'bun:test'
import type { PrDiffSlice } from '@solus/contracts/providers'
import { PullRequestDiffs } from '../../apps/mobile/src/features/prs/pull-request-diffs'
import { PullRequestDirectory } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { pullRequestDiffPatch, retainPullRequestDiffPage } from '../../apps/mobile/src/features/prs/lib/pull-request-diff-pages'
import { shownValue } from '../../apps/mobile/src/features/prs/pull-request-reads'
import { FakeApi, flushPromises } from './helpers/native-mobile-fakes'
import { deferred, detailApi, hostWorld, PR_REF, pullRequest } from './helpers/native-mobile-prs-fixtures'

// A pull request diff arrives in pages that the provider's cursor links. The
// person must never see two revisions mixed, a refreshed page must drop the
// pages whose cursors it made stale, and an older read must not replace a
// newer one.

const slice = (path: string, nextCursor: string | null = null): PrDiffSlice => ({
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  truncated: false,
  nextCursor,
})

describe('diff pages (ported from T3 pullRequestDiffPages.test.ts)', () => {
  test('keeps file order when another page arrives', () => {
    const pages = retainPullRequestDiffPage(retainPullRequestDiffPage([], null, slice('first.ts', 'second')), 'second', slice('second.ts'))
    expect(pullRequestDiffPatch(pages).match(/diff --git a\/(\S+)/g)).toEqual(['diff --git a/first.ts', 'diff --git a/second.ts'])
  })

  test('discards later pages when a refreshed page changes', () => {
    const first = slice('first.ts', 'second')
    const pages = retainPullRequestDiffPage(retainPullRequestDiffPage([], null, first), 'second', slice('second.ts'))
    expect(retainPullRequestDiffPage(pages, null, { ...first })).toBe(pages)
    const refreshed = retainPullRequestDiffPage(pages, null, slice('changed.ts'))
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]?.patch).toContain('changed.ts')
  })
})

describe('pull request diffs store', () => {
  test('reads the shown revision, then follows the provider cursor', async () => {
    const api = new FakeApi().on('prGetDiff', (_ctx: unknown, request: { cursor?: string }) => request.cursor === 'p2' ? slice('b.ts') : slice('a.ts', 'p2'))
    const world = await hostWorld(api)
    const diffs = new PullRequestDiffs((hostId) => world.connections.connection(hostId), () => null)
    const ref = { ...PR_REF, commitSha: 'c1' }
    await diffs.load(ref, { baseSha: 'base', headSha: 'head-7' })
    expect(diffs.canLoadMore(ref)).toBe(true)
    await diffs.loadMore(ref)
    expect(api.callsOf('prGetDiff').map((call) => call[1])).toEqual([
      { number: 7, baseSha: 'base', headSha: 'head-7', commitSha: 'c1' },
      { number: 7, baseSha: 'base', headSha: 'head-7', commitSha: 'c1', cursor: 'p2' },
    ])
    const diff = shownValue(diffs.diffOf(ref))
    expect(diff?.pages.map((page) => page.cursor)).toEqual([null, 'p2'])
    expect(diffs.canLoadMore(ref)).toBe(false)
    // The whole pull request is a different diff from one of its commits.
    expect(diffs.diffOf(PR_REF).kind).toBe('idle')
  })

  test('a refresh starts again from the first page', async () => {
    const api = new FakeApi().on('prGetDiff', (_ctx: unknown, request: { cursor?: string }) => request.cursor ? slice('b.ts') : slice('a.ts', 'p2'))
    const world = await hostWorld(api)
    const diffs = new PullRequestDiffs((hostId) => world.connections.connection(hostId), () => null)
    await diffs.load(PR_REF, { baseSha: 'base', headSha: 'head-7' })
    await diffs.loadMore(PR_REF)
    await diffs.load(PR_REF, { baseSha: 'base', headSha: 'head-8' })
    const diff = shownValue(diffs.diffOf(PR_REF))
    expect(diff?.revision.headSha).toBe('head-8')
    expect(diff?.pages).toHaveLength(1)
  })

  test('an older read that lands last is dropped (stale-read guard)', async () => {
    const first = deferred<PrDiffSlice>()
    const second = deferred<PrDiffSlice>()
    const api = new FakeApi().on('prGetDiff', (_ctx: unknown, request: { headSha: string }) => request.headSha === 'old-head' ? first.promise : second.promise)
    const world = await hostWorld(api)
    const diffs = new PullRequestDiffs((hostId) => world.connections.connection(hostId), () => null)
    const older = diffs.load(PR_REF, { baseSha: 'base', headSha: 'old-head' })
    await flushPromises()
    expect(api.callsOf('prGetDiff')).toHaveLength(1)
    const newer = diffs.load(PR_REF, { baseSha: 'base', headSha: 'new-head' })
    second.resolve(slice('new.ts'))
    await newer
    first.resolve(slice('old.ts'))
    await older
    expect(shownValue(diffs.diffOf(PR_REF))?.revision.headSha).toBe('new-head')
  })

  test('file contents read at the diff revision, and the device copy answers offline', async () => {
    let online = true
    const api = new FakeApi()
      .on('prGetDiff', () => slice('a.ts'))
      .on('prGetDiffFileContents', () => {
        if (!online) throw new Error('socket closed')
        return { oldContents: 'old', newContents: 'new' }
      })
    const world = await hostWorld(api)
    const diffs = new PullRequestDiffs((hostId) => world.connections.connection(hostId), () => null)
    await diffs.load(PR_REF, { baseSha: 'base', headSha: 'head-7' })
    const file = { oldPath: 'a.ts', newPath: 'a.ts', changeType: 'change' as const }
    expect(await diffs.fileContents(PR_REF, file)).toEqual({ oldContents: 'old', newContents: 'new' })
    expect(api.callsOf('prGetDiffFileContents')[0]![1]).toEqual({ number: 7, baseSha: 'base', headSha: 'head-7', commitSha: undefined, ...file })
    online = false
    expect(await diffs.fileContents(PR_REF, file)).toEqual({ oldContents: 'old', newContents: 'new' })
    await expect(diffs.fileContents(PR_REF, { ...file, newPath: 'b.ts' })).rejects.toThrow('socket closed')
  })
})

describe('detail stale-read guard', () => {
  test('a detail read made stale by a newer one does not replace it', async () => {
    const first = deferred<{ pullRequest: ReturnType<typeof pullRequest>; commits: never[]; reviewers: never[] }>()
    const overviews = [first.promise, Promise.resolve({ pullRequest: pullRequest(7, { title: 'New' }), commits: [], reviewers: [] })]
    const api = detailApi(new FakeApi()).on('prGetOverview', () => overviews.shift())
    const world = await hostWorld(api)
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    const older = directory.loadDetail(PR_REF)
    await flushPromises()
    await directory.loadDetail(PR_REF)
    first.resolve({ pullRequest: pullRequest(7, { title: 'Old' }), commits: [], reviewers: [] })
    await older
    expect(shownValue(directory.detailOf(PR_REF))?.overview.pullRequest.title).toBe('New')
  })
})
