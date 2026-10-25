import { describe, expect, test } from 'bun:test'
import { PullRequestActions } from '../../apps/mobile/src/features/prs/pull-request-actions'
import { memoryPullRequestCacheDatabase, PullRequestCache } from '../../apps/mobile/src/features/prs/pull-request-cache'
import { PullRequestDirectory } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { PullRequestReviewDrafts } from '../../apps/mobile/src/features/prs/pull-request-review-drafts'
import { clearSubmittedReview, draftReview, reviewCommentLabel, type ReviewDraft } from '../../apps/mobile/src/features/prs/lib/pull-request-review-draft'
import { pullRequestPermissions } from '../../apps/mobile/src/features/prs/lib/pull-request-permissions'
import { pullRequestAgentActions, pullRequestAgentPrompt } from '../../apps/mobile/src/features/prs/lib/pull-request-agent-tasks'
import { FakeApi } from './helpers/native-mobile-fakes'
import { detailApi, hostWorld, PR_REF, project, pullRequest } from './helpers/native-mobile-prs-fixtures'

// Writes on a pull request change the person's code host. They must name the
// head the person was shown, refuse without a connection instead of failing
// later, show the result by reading the pull request again, and never lose a
// review comment the person wrote and did not send.

async function setup(api: FakeApi, options: { connected?: boolean } = { connected: true }) {
  const world = await hostWorld(api, options)
  const connectionFor = (hostId: string) => world.connections.connection(hostId)
  const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
  const directory = new PullRequestDirectory(connectionFor, () => null, cache)
  let ids = 0
  const drafts = new PullRequestReviewDrafts(cache, () => `c${++ids}`)
  const sessions: Array<{ hostId: string; workingDirectory: string; prompt: string }> = []
  const actions = new PullRequestActions({
    connectionFor,
    organizationId: () => null,
    directory,
    drafts,
    startSession: (hostId, workingDirectory, prompt) => {
      sessions.push({ hostId, workingDirectory, prompt })
      return 'new-session'
    },
  })
  return { world, directory, drafts, actions, sessions, cache }
}

const comment = { path: 'a.ts', side: 'RIGHT' as const, line: 4, body: ' Name this. ', headSha: 'head-7' }

describe('pull request actions', () => {
  test('a write refuses in plain words without a connected host, and calls nothing', async () => {
    const api = detailApi(new FakeApi()).on('prMerge', () => ({ merged: true }))
    const { actions } = await setup(api, { connected: false })
    await expect(actions.merge(PR_REF, 'squash', 'head-7')).rejects.toThrow('Connect to this host to make this change.')
    expect(api.callsOf('prMerge')).toHaveLength(0)
  })

  test('a merge names the shown head and reads the pull request and the list again', async () => {
    const api = detailApi(new FakeApi())
      .on('prMerge', () => ({ merged: true }))
      .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
      .on('prListProjects', () => [])
      .on('providerViewer', () => ({ login: 'me' }))
    const { actions, directory } = await setup(api)
    await actions.merge(PR_REF, 'squash', 'head-7')
    expect(api.callsOf('prMerge')[0]!.slice(1)).toEqual([7, 'squash', 'head-7'])
    expect(api.callsOf('prGetOverview')).toHaveLength(1)
    expect(api.callsOf('prListProjects')).toHaveLength(1)
    expect(directory.detailOf(PR_REF).kind).toBe('loaded')
    expect(actions.runningOf(PR_REF)).toBeNull()
  })

  test('a merge the host refuses throws its reason, and the pull request is still read again', async () => {
    const api = detailApi(new FakeApi())
      .on('prMerge', () => ({ merged: false, message: 'Required checks are failing.' }))
      .on('listProjects', () => [])
    const { actions } = await setup(api)
    await expect(actions.merge(PR_REF, 'merge', 'head-7')).rejects.toThrow('Required checks are failing.')
    expect(api.callsOf('prGetOverview')).toHaveLength(1)
  })

  test('thread replies and resolution go to the host, then the threads are read again', async () => {
    const api = detailApi(new FakeApi())
      .on('prReplyThread', () => ({ id: 'r', author: 'me', body: 'ok', createdAt: '' }))
      .on('prResolveThread', () => undefined)
      .on('prUnresolveThread', () => undefined)
    const { actions } = await setup(api)
    await actions.replyToThread(PR_REF, 't1', ' Done. ')
    await actions.setThreadResolved(PR_REF, 't1', true)
    await actions.setThreadResolved(PR_REF, 't1', false)
    expect(api.callsOf('prReplyThread')[0]!.slice(1)).toEqual([7, 't1', 'Done.'])
    expect(api.callsOf('prResolveThread')).toHaveLength(1)
    expect(api.callsOf('prUnresolveThread')).toHaveLength(1)
    expect(api.callsOf('prListThreads')).toHaveLength(3)
  })

  test('a review sends the inline comments written on the shown head, then clears only what it sent', async () => {
    const api = detailApi(new FakeApi()).on('prSubmitReview', () => undefined)
    const { actions, drafts } = await setup(api)
    drafts.setSummary(PR_REF, 'Looks close.')
    drafts.addComment(PR_REF, comment)
    drafts.addComment(PR_REF, { ...comment, line: 9, startLine: 7, body: 'Old head', headSha: 'head-6' })
    await actions.submitReview(PR_REF, { verdict: 'request-changes', body: '  Please add a test. ', headSha: 'head-7', baseSha: 'merge-base' })
    expect(api.callsOf('prSubmitReview')[0]!.slice(1)).toEqual([7, {
      body: 'Please add a test.',
      event: 'REQUEST_CHANGES',
      commitId: 'head-7',
      baseSha: 'merge-base',
      comments: [{ path: 'a.ts', line: 4, side: 'RIGHT', body: 'Name this.' }],
    }])
    // The comment on an older head was not sent, so it stays.
    expect(drafts.draftOf(PR_REF)).toEqual({ summary: '', comments: [{ ...comment, line: 9, startLine: 7, body: 'Old head', headSha: 'head-6', id: 'c2' }] })
  })

  test('a refused review keeps the whole draft', async () => {
    const api = detailApi(new FakeApi()).on('prSubmitReview', () => { throw new Error('head moved') })
    const { actions, drafts } = await setup(api)
    drafts.addComment(PR_REF, comment)
    await expect(actions.submitReview(PR_REF, { verdict: 'comment', body: '', headSha: 'head-7' })).rejects.toThrow('head moved')
    expect(drafts.draftOf(PR_REF).comments).toHaveLength(1)
  })

  test('agent work runs in the pull request checkout the host prepared', async () => {
    const target = { host: 'github.com', owner: 'o', repo: 'r', number: 7, title: 'PR 7', baseRef: 'main', headRef: 'feature', baseSha: 'base', headSha: 'head-7', headRepo: { owner: 'o', repo: 'r', isFork: false } }
    const api = new FakeApi()
      .on('prOpenReview', () => target)
      .on('prPrepareCheckout', () => ({ worktreePath: '/work/app/.git/solus/worktrees/pr-7', branch: 'feature', baseSha: 'base', headSha: 'head-7' }))
      .on('prPrepareConflictResolution', () => ({ success: true, review: { ...target, worktreePath: '/work/app/.git/solus/worktrees/pr-7-merge', branch: 'feature', baseSha: 'base', headSha: 'head-7' }, conflictFiles: ['a.ts'], headRef: 'feature' }))
    const { actions, sessions } = await setup(api)
    const pr = pullRequest(7)
    expect(await actions.startAgentWork(PR_REF, 'explain', pr)).toEqual({ hostId: 'inst-a', sessionId: 'new-session' })
    expect(sessions[0]!.workingDirectory).toBe('/work/app')
    expect(sessions[0]!.prompt).toContain('Pull request #7')
    await actions.startAgentWork(PR_REF, 'conflicts', pr)
    expect(sessions[1]!.prompt).toContain('- a.ts')
    await expect(actions.startAgentWork(PR_REF, 'ask', pr, '  ')).rejects.toThrow('Write your question first.')
    expect(api.callsOf('prGetOverview')).toHaveLength(0)
  })
})

describe('review drafts', () => {
  test('a draft survives a new app run through the pull request cache, and a discard removes it', async () => {
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
    const first = new PullRequestReviewDrafts(cache, () => 'c1')
    first.setSummary(PR_REF, 'Summary')
    first.addComment(PR_REF, comment)
    await first.flush()
    const second = new PullRequestReviewDrafts(cache, () => 'c2')
    await second.load(PR_REF)
    expect(second.draftOf(PR_REF)).toEqual({ summary: 'Summary', comments: [{ ...comment, id: 'c1' }] })
    second.discard(PR_REF)
    await second.flush()
    const third = new PullRequestReviewDrafts(cache, () => 'c3')
    await third.load(PR_REF)
    expect(third.draftOf(PR_REF).comments).toEqual([])
  })

  test('an edit made before the kept draft is read is not replaced by it', async () => {
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
    const first = new PullRequestReviewDrafts(cache, () => 'c1')
    first.setSummary(PR_REF, 'Old')
    await first.flush()
    const second = new PullRequestReviewDrafts(cache, () => 'c2')
    const loading = second.load(PR_REF)
    second.setSummary(PR_REF, 'New')
    await loading
    expect(second.draftOf(PR_REF).summary).toBe('New')
  })

  test('a range comment sends its first line; a single line sends none (ported from T3)', () => {
    const review = draftReview({ verdict: 'comment', body: '', headSha: 'h', comments: [
      { id: '1', path: 'a.ts', side: 'RIGHT', line: 5, startLine: 3, body: 'range', headSha: 'h' },
      { id: '2', path: 'a.ts', side: 'LEFT', line: 5, startLine: 5, body: 'one', headSha: 'h' },
    ] })
    expect(review.comments).toEqual([
      { path: 'a.ts', side: 'RIGHT', line: 5, startLine: 3, body: 'range' },
      { path: 'a.ts', side: 'LEFT', line: 5, body: 'one' },
    ])
    expect(reviewCommentLabel({ side: 'LEFT', line: 7 })).toBe('Old line 7')
    expect(reviewCommentLabel({ side: 'RIGHT', line: 5, startLine: 3 })).toBe('Lines 3–5')
  })

  test('clears a submitted snapshot while keeping edits made during the request (ported from T3)', () => {
    const sent: ReviewDraft = { summary: 'Review', comments: [{ id: 'one', path: 'a.ts', side: 'RIGHT', line: 2, body: 'Keep this', headSha: 'abc' }] }
    const current: ReviewDraft = { summary: 'New summary', comments: [{ ...sent.comments[0]!, body: 'New feedback' }, { ...sent.comments[0]!, id: 'two' }, { ...sent.comments[0]!, line: 12 }] }
    expect(clearSubmittedReview(current, sent)).toEqual(current)
    expect(clearSubmittedReview(sent, sent)).toEqual({ summary: '', comments: [] })
  })
})

describe('pull request permissions (ported from T3 usePullRequestPermissions)', () => {
  const capable = pullRequest(7, {
    capabilities: { ...pullRequest(7).capabilities, actions: ['merge', 'close', 'ready', 'draft', 'enable-auto-merge', 'disable-auto-merge'], mergeMethods: ['squash', 'merge'], defaultMergeMethod: 'squash', reviewerRequests: true, labelManagement: true },
    viewerPermissions: { ...pullRequest(7).viewerPermissions, actions: ['merge', 'close', 'ready', 'draft', 'enable-auto-merge', 'disable-auto-merge'], resolveThreads: true, requestReviewers: true, manageLabels: true },
  })

  test('without a connection nothing can be written, but the reason to connect is given', () => {
    const offline = pullRequestPermissions(capable, 'reviewer', false)
    expect([offline.canMerge, offline.canComment, offline.verdicts, offline.lifecycle]).toEqual([false, false, [], []])
    expect(offline.mergeUnavailableReason).toBe('Connect to this host to merge.')
  })

  test('the state narrows what the host and the account allow', () => {
    const open = pullRequestPermissions(capable, 'reviewer', true)
    expect(open.canMerge).toBe(true)
    expect(open.defaultMergeMethod).toBe('squash')
    expect(open.lifecycle).toEqual(['draft', 'close'])
    expect(open.verdicts).toEqual(['comment', 'approve', 'request-changes'])
    expect(open.canInlineComment && open.canResolve && open.canRequestReviewers && open.canManageLabels).toBe(true)
    const draft = pullRequestPermissions({ ...capable, draft: true }, 'reviewer', true)
    expect(draft.canMerge).toBe(false)
    expect(draft.lifecycle).toEqual(['ready', 'close'])
    const conflicted = pullRequestPermissions({ ...capable, mergeStateStatus: 'dirty' }, 'reviewer', true)
    expect(conflicted.mergeUnavailableReason).toBe('Resolve the conflicts with the base branch before you merge.')
    const merged = pullRequestPermissions({ ...capable, state: 'merged' }, 'reviewer', true)
    expect([merged.canMerge, merged.verdicts, merged.lifecycle]).toEqual([false, [], []])
  })

  test('auto-merge is offered only while the merge is held, and update branch only when behind', () => {
    expect(pullRequestPermissions({ ...capable, mergeStateStatus: 'clean' }, null, true).canEnableAutoMerge).toBe(false)
    const behind = pullRequestPermissions({ ...capable, mergeStateStatus: 'behind' }, null, true)
    expect([behind.canEnableAutoMerge, behind.canUpdateBranch]).toEqual([true, true])
    const armed = pullRequestPermissions({ ...capable, mergeStateStatus: 'blocked', autoMergeEnabled: true }, null, true)
    expect([armed.canEnableAutoMerge, armed.canDisableAutoMerge]).toEqual([false, true])
  })

  test('the author may comment on their own pull request but not approve it', () => {
    expect(pullRequestPermissions(capable, 'someone', true).verdicts).toEqual(['comment'])
  })

  test('agent tasks that change the branch need a head the person may push to', () => {
    const fork = { ...capable, headRepo: { owner: 'x', repo: 'r', isFork: true } }
    const actions = pullRequestAgentActions(fork, pullRequestPermissions(fork, null, true).canUpdateHead)
    expect(actions.filter((action) => !action.disabled).map((action) => action.task)).toEqual(['ask', 'explain'])
    expect(pullRequestAgentPrompt('ask', capable, ' Why? ')).toBe(`Pull request #7 ("PR 7", https://github.com/o/r/pull/7): branch feature into main. This session runs in a checkout of its head.\n\nWhy?`)
  })
})

test('a written review comment is never shown as sent before the host accepts it', async () => {
  const api = detailApi(new FakeApi()).on('prSubmitReview', () => new Promise(() => undefined))
  const { actions, drafts } = await setup(api)
  drafts.addComment(PR_REF, comment)
  void actions.submitReview(PR_REF, { verdict: 'comment', body: '', headSha: 'head-7' })
  expect(drafts.draftOf(PR_REF).comments).toHaveLength(1)
  expect(actions.runningOf(PR_REF)).toBe('review')
})

test('the filter search asks each project in scope and merges what they answer', async () => {
  // WHY: the phone's label and author search must offer what the repositories
  // have beyond the loaded rows, as web does; a project that cannot answer
  // must not hide the choices of the others.
  const api = new FakeApi().on('prFilterOptions', (ctx: { session: { projectPath: string } }, field: string, query: string) => {
    if (ctx.session.projectPath === '/work/broken') throw new Error('Not Found')
    return ctx.session.projectPath === '/work/app'
      ? [{ value: `${field}:${query}` }, { value: 'shared' }]
      : [{ value: 'Shared' }, { value: 'other' }]
  })
  const { actions } = await setup(api)
  const projects = ['/work/app', '/work/broken', '/work/api'].map((projectPath) => ({ hostId: PR_REF.hostId, projectPath }))
  expect(await actions.filterOptions(projects, 'label', 'p1')).toEqual([{ value: 'label:p1' }, { value: 'shared' }, { value: 'other' }])
  // A host that is not connected is not asked.
  expect(await actions.filterOptions([{ hostId: 'not-paired', projectPath: '/work/app' }], 'author', '')).toEqual([])
  expect(api.callsOf('prFilterOptions')).toHaveLength(3)
})
