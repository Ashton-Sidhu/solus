import { afterEach, describe, expect, test } from 'bun:test'
import type { PrListPage, PullRequest } from '@solus/contracts/providers'
import type { PrGuideMetadataRequest, ReviewGuideStatusEvent } from '@solus/contracts/review'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
}

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function ctxFor(projectPath: string): IpcContext {
  return {
    session: { projectPath, workingDirectory: projectPath },
    window: {},
    settings: {},
    statusBar: {},
  } as IpcContext
}

const BASE_REPO = { host: 'github.com', owner: 'acme', repo: 'a' }

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    url: `https://github.com/acme/a/pull/${number}`,
    title: `PR #${number}`,
    headSha: `sha-${number}`,
    baseSha: `base-${number}`,
    baseRepo: BASE_REPO,
    headRepo: { owner: 'acme', repo: 'a', isFork: false },
    author: 'octocat',
    authorAvatarUrl: '',
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    body: '',
    baseRef: 'main',
    headRef: `feature/${number}`,
    changedFiles: null,
    mergeable: null,
    mergeStateStatus: null,
    capabilities: {
      diff: true,
      diffFileContents: true,
      inlineComments: true,
      threadReplies: true,
      threadResolution: true,
      reviewVerdicts: ['comment', 'approve', 'request-changes'],
      actions: ['merge', 'close', 'reopen', 'ready', 'draft'],
      mergeMethods: ['squash'],
      reviewerRequests: true,
      reviewerCandidates: true,
      labelManagement: true,
    },
    viewerPermissions: {
      actions: ['merge', 'close'],
      reviewVerdicts: ['comment', 'approve', 'request-changes'],
      comment: true,
      resolveThreads: true,
      requestReviewers: true,
      manageLabels: true,
    },
    ...overrides,
  }
}

const NO_CHECKS = {
  prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
  prGuideMetadata: async () => null,
}

describe('PrsStore lookups are scoped to one project', () => {
  test('a label write updates the indexed pull request and its visible list row', async () => {
    // WHY: the detail picker and PR list stay mounted together. A label edit
    // is applied through the one path every write and host broadcast takes,
    // so the shared PR object and the row it is listed on agree without a
    // second update path to keep in step.
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const labels = [{ name: 'bug', color: 'd73a4a' }]
    let commentReads = 0
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(65)], page: 1, hasMore: false }),
      prSetLabels: async () => pr(65, { labels }),
      prListComments: async () => {
        commentReads++
        return []
      },
      ...NO_CHECKS,
    })
    const project = store.get(api, 'host-a', ctxFor('/repos/a'))
    await project.list()
    const pullRequest = project.get(65)
    const held = project.items[0]
    await pullRequest.loadComments()

    await pullRequest.setLabels(['bug'])

    expect(pullRequest.labels).toEqual(labels)
    expect(held.labels).toEqual(labels)
    expect(project.items[0]).toBe(held)
    // The host wrote a labeled row into the conversation, so the next read
    // must go and look rather than answer from before the write.
    await pullRequest.loadComments()
    expect(commentReads).toBe(2)
  })

  test('a project answers only for its own pull requests, whatever another project last listed', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const apiA = asHostApi({
      prList: async (): Promise<PrListPage> => ({
        items: [pr(65, { title: 'A-65', headRef: 'feature/a' })],
        page: 1,
        hasMore: false,
      }),
      ...NO_CHECKS,
    })
    const apiB = asHostApi({
      prList: async (): Promise<PrListPage> => ({
        items: [pr(65, { title: 'B-65', headRef: 'feature/b' })],
        page: 1,
        hasMore: false,
      }),
      ...NO_CHECKS,
    })

    await store.get(apiA, 'host-a', ctxFor('/repos/a')).query({ state: 'open' })
    await store.get(apiB, 'host-b', ctxFor('/repos/b')).query({ state: 'open' })

    // The same number in two repositories is two different pull requests. This
    // is what the sidebar got wrong by scanning whichever list was on screen.
    expect((store.at('host-a', '/repos/a')?.prFor(65) ?? null)?.title).toBe('A-65')
    expect((store.at('host-b', '/repos/b')?.prFor(65) ?? null)?.title).toBe('B-65')
  })

  test('a project that has listed nothing answers null rather than another project\'s row', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(65)], page: 1, hasMore: false }),
      ...NO_CHECKS,
    })
    await store.get(api, 'host-a', ctxFor('/repos/a')).query({ state: 'open' })

    expect((store.at('host-a', '/repos/a')?.prFor(65) ?? null)).not.toBeNull()
    expect((store.at('host-a', '/repos/never-listed')?.prFor(65) ?? null)).toBeNull()
    expect((store.at(null, '/repos/a')?.prFor(65) ?? null)).toBeNull()
  })

  test('a branch resolves to its pull request without another request', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({
        items: [pr(7, { headRef: 'feature/login' })],
        page: 1,
        hasMore: false,
      }),
      ...NO_CHECKS,
    })
    await store.get(api, 'host-a', ctxFor('/repos/a')).query({ state: 'open' })

    expect((store.at('host-a', '/repos/a')?.prForBranch('feature/login') ?? null)?.number).toBe(7)
    expect((store.at('host-a', '/repos/a')?.prForBranch('feature/other') ?? null)).toBeNull()
  })
})

describe('one pull request, one object', () => {
  test('a detail read through one route is the same pull request the list indexed', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const ctx = ctxFor('/repos/a')

    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({
        items: [pr(7, { title: 'From the list', headRef: 'feature/x' })],
        page: 1,
        hasMore: false,
      }),
      prGetDetail: async () =>
        ({ ...pr(7, { title: 'From the detail', headRef: 'feature/x' }), body: 'why' }) as PullRequest,
      ...NO_CHECKS,
    })

    await store.get(api, 'host-a', ctx).query({ state: 'open' })
    const fromList = store.get(api, 'host-a', ctx).get(7)
    await store.get(api, 'host-a', ctx).get(7).loadDetail()

    // The summary index and the detail index used to be two maps, so a surface
    // reading one could show a pull request the other had already moved past.
    // There is one pull request now — the object itself, not a record inside
    // one — and this is what says so.
    expect(fromList.body).toBe('why')
    expect(fromList.title).toBe('From the detail')
    expect((store.at('host-a', '/repos/a')?.prFor(7) ?? null)?.title).toBe('From the detail')
    expect((store.at('host-a', '/repos/a')?.prFor(7) ?? null)?.body).toBe('why')
  })
})

describe('a refresh reaches the code host', () => {
  test('a forced list read tells the host to forget first; an ordinary one does not', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let invalidations = 0
    const order: string[] = []
    const api = asHostApi({
      prInvalidate: async () => {
        invalidations++
        order.push('invalidate')
      },
      prList: async (): Promise<PrListPage> => {
        order.push('list')
        return { items: [pr(7)], page: 1, hasMore: false }
      },
      ...NO_CHECKS,
    })

    await store.get(api, 'host-a', ctxFor('/repos/a')).list()
    // An ordinary read shares whatever the host has already fetched; only a
    // person's refresh is allowed to spend a code-host request.
    expect(invalidations).toBe(0)

    await store.get(api, 'host-a', ctxFor('/repos/a')).list({ force: true })
    expect(invalidations).toBe(1)
    // And it has to land before the read, or the read is served the very answer
    // the refresh was asking to replace.
    expect(order).toEqual(['list', 'invalidate', 'list'])
  })

  test('a refresh still shows it is reading when the host cannot be told to forget', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const api = asHostApi({
      prInvalidate: async () => { throw new Error('no repository here') },
      prList: async (): Promise<PrListPage> => ({ items: [pr(7)], page: 1, hasMore: false }),
      ...NO_CHECKS,
    })

    // The read that follows owns the error message, so a refused invalidation
    // must not become the one the user sees.
    await store.get(api, 'host-a', ctxFor('/repos/a')).list({ force: true })
    expect((store.at('host-a', '/repos/a')?.prFor(7) ?? null)?.number).toBe(7)
  })
})

describe('review guide metadata is scoped to one pull request', () => {
  test('loading a list does not scan its rows; an explicit pull request check reads only that pull request', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrGuidesStore } = await import('@solus/workspace-ui/contexts/prs/pr-guides.store.svelte')
    const store = new PrsStore()
    // Guides hang off the pull requests the store indexed, but are their own
    // domain: Solus made them, the code host has never heard of them.
    const guides = new PrGuidesStore(store)
    const ctx = ctxFor('/repos/a')
    const requests: PrGuideMetadataRequest[] = []
    const target = pr(7)
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [target, pr(8)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
      prGuideMetadata: async (_ctx, request) => {
        requests.push(request)
        return {
          number: request.number,
          headSha: request.headSha,
          generatedAt: '2026-01-01T00:00:00Z',
          current: true,
        }
      },
    })

    await store.get(api, 'host-a', ctx).list()
    expect(requests).toEqual([])

    await guides.loadMetadata(api, 'host-a', ctx, target)
    expect(requests).toEqual([{ number: 7, headSha: 'sha-7' }])
    expect(guides.metadataFor('host-a', ctx, 7)?.current).toBe(true)
    expect(guides.metadataFor('host-a', ctx, 8)).toBeUndefined()
  })

  test('a branch guide for an open PR head shares its live generation state with PR surfaces', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrGuidesStore } = await import('@solus/workspace-ui/contexts/prs/pr-guides.store.svelte')
    const store = new PrsStore()
    const guides = new PrGuidesStore(store)
    const ctx = ctxFor('/repos/a')
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(7), pr(8)], page: 1, hasMore: false }),
      ...NO_CHECKS,
    })
    await store.get(api, 'host-a', ctx).list()

    const event: ReviewGuideStatusEvent = {
      repoRoot: '/repos/a',
      key: 'branch:feature/7',
      scope: 'branch',
      status: 'generating',
      headSha: 'sha-7',
      updatedAt: Date.now(),
    }
    guides.applyReviewGuideStatus('host-a', event)

    expect(guides.statusFor('host-a', ctx, 7)).toBe('generating')
    expect(guides.statusFor('host-a', ctx, 8)).toBeUndefined()

    guides.applyReviewGuideStatus('host-a', { ...event, status: 'cancelled' })
    expect(guides.statusFor('host-a', ctx, 7)).toBeUndefined()
  })

  test('a session guide at the same commit is not presented as a PR guide', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrGuidesStore } = await import('@solus/workspace-ui/contexts/prs/pr-guides.store.svelte')
    const store = new PrsStore()
    const guides = new PrGuidesStore(store)
    const ctx = ctxFor('/repos/a')
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(7)], page: 1, hasMore: false }),
      ...NO_CHECKS,
    })
    await store.get(api, 'host-a', ctx).list()

    guides.applyReviewGuideStatus('host-a', {
      repoRoot: '/repos/a',
      key: 'session:abc',
      scope: 'session',
      status: 'generating',
      headSha: 'sha-7',
      updatedAt: Date.now(),
    })

    expect(guides.statusFor('host-a', ctx, 7)).toBeUndefined()
  })
})

describe('PrsStore learns about a pull request Solus just created', () => {
  test('the step carries the provider\'s pull request, so nothing is invented and nothing is re-read', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let detailReads = 0
    const api = asHostApi({
      prGetDetail: async () => {
        detailReads++
        return pr(42)
      },
    })
    const created = pr(42, { title: 'Real title', headRef: 'feature/new' })

    store.get(api, 'host-a', ctxFor('/repos/a')).absorbCreated({
      status: 'created',
      url: created.url,
      number: 42,
      title: '#42',
      pullRequest: created,
    })

    // The rail names it on this frame, with what the provider said — not with a
    // placeholder that a later read has to correct. `viewerPermissions` is the
    // proof: a fabricated row could not know them.
    expect((store.at('host-a', '/repos/a')?.prForBranch('feature/new') ?? null)?.title).toBe('Real title')
    expect((store.at('host-a', '/repos/a')?.prFor(42) ?? null)?.viewerPermissions.actions).toContain('merge')

    await Bun.sleep(5)
    expect(detailReads).toBe(0)
  })

  test('a step the host could not read back is asked for by number', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let detailReads = 0
    const api = asHostApi({
      prGetDetail: async () => {
        detailReads++
        return pr(42, { title: 'Real title', headRef: 'feature/new' })
      },
    })

    store.get(api, 'host-a', ctxFor('/repos/a')).absorbCreated({
      status: 'created',
      url: 'https://github.com/acme/a/pull/42',
      number: 42,
      title: '#42',
      pullRequest: null,
    })

    await Bun.sleep(5)
    expect(detailReads).toBe(1)
    expect((store.at('host-a', '/repos/a')?.prForBranch('feature/new') ?? null)?.title).toBe('Real title')
  })

  test('a step with neither a pull request nor a number indexes nothing', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let detailReads = 0
    const api = asHostApi({
      prGetDetail: async () => {
        detailReads++
        return pr(1)
      },
    })

    store.get(api, 'host-a', ctxFor('/repos/a')).absorbCreated({
      status: 'created',
      url: 'https://example.invalid/whatever',
      number: null,
      title: 'x',
      pullRequest: null,
    })

    expect((store.at('host-a', '/repos/a')?.prForBranch('feature/new') ?? null)).toBeNull()
    expect(detailReads).toBe(0)
  })
})

describe('PrsStore indexes the full detail so surfaces cannot go stale', () => {
  test('a lifecycle change reaches a surface reading the detail index', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const ctx = ctxFor('/repos/a')

    const api = asHostApi({
      prGetDetail: async () => ({
        ...pr(3, { headRef: 'feature/x' }),
        body: '',
        baseRef: 'main',
        headRef: 'feature/x',
        baseSha: 'base',
        changedFiles: 1,
        mergeable: true,
        mergeStateStatus: null,
        headRepo: { owner: 'acme', repo: 'a', isFork: false },
      }),
    })

    await store.get(api, 'host-a', ctx).get(3).loadDetail()
    expect((store.at('host-a', '/repos/a')?.prFor(3) ?? null)?.state).toBe('open')

    // A merge landing anywhere — the host broadcast, another pane — is applied
    // through the store, and the index is what every surface reads.
    const merged = { ...((store.at('host-a', '/repos/a')?.prFor(3) ?? null)!), state: 'merged' as const }
    store.at('host-a', projectScopeOf(ctx.session))?.applyPullRequest(merged)

    expect((store.at('host-a', '/repos/a')?.prFor(3) ?? null)?.state).toBe('merged')
    // …and the summary lookup agrees, so a row and a rail cannot disagree.
    expect((store.at('host-a', '/repos/a')?.prFor(3) ?? null)?.state).toBe('merged')
  })

  test('a listed pull request already answers what the viewer may do to it', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(9)], page: 1, hasMore: false }),
      ...NO_CHECKS,
    })
    await store.get(api, 'host-a', ctxFor('/repos/a')).query({ state: 'open' })

    // A list row and a direct read are the same pull request. A surface gating
    // a merge affordance off `viewerPermissions` gets its answer from the
    // listing, without a second read and without a half-filled object to guard
    // against.
    const listed = (store.at('host-a', '/repos/a')?.prFor(9) ?? null)
    expect(listed?.viewerPermissions.actions).toContain('merge')
    expect(listed?.url).toBe('https://github.com/acme/a/pull/9')
  })
})

describe('PrsStore carries an optimistic lifecycle edit and its rollback', () => {
  // The Activity tab applies the pending state, then either the confirmed one
  // or a revert — all through the store, so every surface shows the same thing
  // and reference equality still works as the in-flight mutation token.
  function detailOf(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
    return {
      ...pr(number),
      body: '',
      baseRef: 'main',
      headRef: 'feature/x',
      baseSha: 'base',
      changedFiles: 1,
      mergeable: true,
      mergeStateStatus: null,
      headRepo: { owner: 'acme', repo: 'a', isFork: false },
      ...overrides,
    } as PullRequest
  }

  test('the optimistic value is visible to every surface, and a revert restores the previous one', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const ctx = ctxFor('/repos/a')

    // A surface has the pull request open, which is what creates the scope —
    // `applyDetail` deliberately does not allocate one per host broadcast.
    const previous = detailOf(5, { draft: true })
    await store.get(asHostApi({ prGetDetail: async () => previous }), 'host-a', ctx).get(5).loadDetail()
    expect((store.at('host-a', '/repos/a')?.prFor(5) ?? null)?.draft).toBe(true)

    const optimistic = { ...previous, draft: false }
    store.at('host-a', projectScopeOf(ctx.session))?.applyPullRequest(optimistic)
    expect((store.at('host-a', '/repos/a')?.prFor(5) ?? null)?.draft).toBe(false)

    // The host refused: nothing else has written since, so the lifecycle the
    // caller wrote is still the one the store holds and the rollback applies.
    expect((store.at('host-a', '/repos/a')?.prFor(5) ?? null)?.draft).toBe(optimistic.draft)
    store.at('host-a', projectScopeOf(ctx.session))?.applyPullRequest(previous)
    expect((store.at('host-a', '/repos/a')?.prFor(5) ?? null)?.draft).toBe(true)
  })

  test('one pull request is one object, so an edit does not replace what a surface holds', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const ctx = ctxFor('/repos/a')

    const first = detailOf(9, { title: 'Before' })
    await store.get(asHostApi({ prGetDetail: async () => first }), 'host-a', ctx).get(9).loadDetail()
    const held = store.at('host-a', '/repos/a')?.prFor(9) ?? null

    // A surface that captured the pull request sees the edit, because the store
    // writes the fields of the one object rather than swapping in a new record.
    store.at('host-a', projectScopeOf(ctx.session))?.applyPullRequest({ ...first, title: 'After' })
    expect(held?.title).toBe('After')
    expect(store.at('host-a', '/repos/a')?.prFor(9)).toBe(held)
  })

  test('a newer write wins over a rollback, because the token no longer matches', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const ctx = ctxFor('/repos/a')

    const optimistic = detailOf(6, { draft: false })
    await store.get(asHostApi({ prGetDetail: async () => detailOf(6) }), 'host-a', ctx).get(6).loadDetail()
    store.at('host-a', projectScopeOf(ctx.session))?.applyPullRequest(optimistic)

    // A provider broadcast lands while the mutation is still in flight.
    const fromHost = detailOf(6, { state: 'merged' })
    store.at('host-a', projectScopeOf(ctx.session))?.applyPullRequest(fromHost)

    // The failing mutation must NOT roll this back — the lifecycle it wrote is
    // no longer the one the store holds, which is what its caller checks.
    const current = store.at('host-a', '/repos/a')?.prFor(6) ?? null
    expect(current?.state === optimistic.state && current.draft === optimistic.draft).toBe(false)
    expect(current?.state).toBe('merged')
  })
})

describe('PrsStore stops asking for a pull request the provider refuses', () => {
  test('a number that fails once is not requested again', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let detailReads = 0
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [], page: 1, hasMore: false }),
      prGetDetail: async () => {
        detailReads++
        throw new Error('Not Found')
      },
      ...NO_CHECKS,
    })
    const target = {
      serverId: 'host-a',
      projectRoot: '/repos/a',
      label: 'A',
      api,
      ctx: ctxFor('/repos/a'),
    }

    store.get(target.api, target.serverId, target.ctx).ensureNumbers([999])
    await Bun.sleep(5)
    store.get(target.api, target.serverId, target.ctx).ensureNumbers([999])
    await Bun.sleep(5)

    // Without the negative cache a render-driven caller re-asks forever: the
    // failed read leaves no cache entry to hit.
    expect(detailReads).toBe(1)
    expect((store.at('host-a', '/repos/a')?.prFor(999) ?? null)).toBeNull()
  })
})
