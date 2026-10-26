import { describe, expect, test } from 'bun:test'
import type { PrCommentActivityItem } from '@solus/contracts/providers'
import { isOwnConversationComment } from '../../packages/client-core/src/pull-request-comments'
import { PullRequestActions } from '../../apps/mobile/src/features/prs/pull-request-actions'
import { memoryPullRequestCacheDatabase, PullRequestCache } from '../../apps/mobile/src/features/prs/pull-request-cache'
import { PullRequestDirectory } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { PullRequestReviewDrafts } from '../../apps/mobile/src/features/prs/pull-request-review-drafts'
import { canDeleteComment, pullRequestPermissions } from '../../apps/mobile/src/features/prs/lib/pull-request-permissions'
import { FakeApi } from './helpers/native-mobile-fakes'
import { detailApi, hostWorld, PR_REF, project, pullRequest } from './helpers/native-mobile-prs-fixtures'

// Mobile edits a pull request's title and description and deletes the
// person's own comments with the same rules as the web client. A delete
// offered on someone else's comment, or on a review body, would fail on
// GitHub or remove the wrong thing; a write without the host must not start.

async function setup(api: FakeApi, options: { connected?: boolean } = { connected: true }) {
  const world = await hostWorld(api, options)
  const connectionFor = (hostId: string) => world.connections.connection(hostId)
  const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
  const directory = new PullRequestDirectory(connectionFor, () => null, cache)
  const actions = new PullRequestActions({
    connectionFor,
    organizationId: () => null,
    directory,
    drafts: new PullRequestReviewDrafts(cache, () => 'c1'),
    startSession: () => 'unused',
  })
  return { directory, actions }
}

const comment = (overrides: Partial<PrCommentActivityItem> = {}): PrCommentActivityItem => ({ id: 'ic-1', kind: 'comment', author: 'Me', body: 'Thanks', createdAt: '2026-10-01T00:00:00Z', ...overrides })

describe('own conversation comments', () => {
  test('are the comments the viewer wrote, whatever the case of the login', () => {
    expect(isOwnConversationComment(comment(), 'me')).toBe(true)
    expect(isOwnConversationComment(comment({ author: 'someone' }), 'me')).toBe(false)
  })

  test('a review body is not one, and nothing is without a known viewer', () => {
    expect(isOwnConversationComment(comment({ kind: 'review' }), 'me')).toBe(false)
    expect(isOwnConversationComment(comment(), null)).toBe(false)
  })

  test('mobile offers the delete only while the host is connected', () => {
    const pr = pullRequest(7)
    expect(canDeleteComment(pullRequestPermissions(pr, 'me', true), comment(), 'me')).toBe(true)
    expect(canDeleteComment(pullRequestPermissions(pr, 'me', false), comment(), 'me')).toBe(false)
  })
})

describe('pull request edits', () => {
  test('the title and description may be edited while the host is connected, as on web', () => {
    expect(pullRequestPermissions(pullRequest(7), 'someone', true).canEditPullRequest).toBe(true)
    expect(pullRequestPermissions(pullRequest(7, { state: 'merged' }), null, true).canEditPullRequest).toBe(true)
    expect(pullRequestPermissions(pullRequest(7), 'someone', false).canEditPullRequest).toBe(false)
    expect(pullRequestPermissions(null, null, true).canEditPullRequest).toBe(false)
  })

  test('an edit sends only the changed field, then reads the pull request and the list again', async () => {
    const api = detailApi(new FakeApi())
      .on('prUpdate', () => pullRequest(7, { title: 'New title' }))
      .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
      .on('prListProjects', () => [])
      .on('providerViewer', () => ({ login: 'me' }))
    const { actions } = await setup(api)
    await actions.update(PR_REF, { title: 'New title' })
    expect(api.callsOf('prUpdate')[0]!.slice(1)).toEqual([7, { title: 'New title' }])
    expect(api.callsOf('prGetOverview')).toHaveLength(1)
    expect(api.callsOf('prListProjects')).toHaveLength(1)
    expect(actions.runningOf(PR_REF)).toBeNull()
  })

  test('an edit without a connected host is refused and calls nothing', async () => {
    const api = detailApi(new FakeApi()).on('prUpdate', () => pullRequest(7))
    const { actions } = await setup(api, { connected: false })
    await expect(actions.update(PR_REF, { body: 'x' })).rejects.toThrow('Connect to this host to make this change.')
    expect(api.callsOf('prUpdate')).toHaveLength(0)
  })

  test('a delete names the comment, then reads the conversation again', async () => {
    const api = detailApi(new FakeApi()).on('prDeleteIssueComment', () => undefined)
    const { actions } = await setup(api)
    await actions.deleteComment(PR_REF, 'ic-1')
    expect(api.callsOf('prDeleteIssueComment')[0]!.slice(1)).toEqual([7, 'ic-1'])
    expect(api.callsOf('prListComments')).toHaveLength(1)
  })
})
