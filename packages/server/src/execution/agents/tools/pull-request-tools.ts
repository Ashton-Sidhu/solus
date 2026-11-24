import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AgentPullRequestSummary } from '../../../providers/types'
import type { CheckItem } from '@solus/contracts/checks-types'
import type { PrMergeMethod, PullRequest } from '@solus/contracts/providers'
import { repositoryKeyOf } from '@solus/contracts/repository-key'
import { assertRpcAccess, authorize, type ResourceAccess } from '../../../admission/access-policy'
import { getInstallationId } from '../../../admission/auth'
import { recordScopeOf, type Principal } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { linkedPullRequestRepository, readLinkedMetadata, threadPullRequestPage } from './thread-pull-requests'
import { assertPathInScope } from '../../../data/sessions/guest-path-scope'
import { completeTasksForMergedPullRequest } from '../../../data/tasks/done-on-merge'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { runAsync } from '../../../git/exec'
import { parsePatch } from '../../../git/interdiff'
import { resolvePushDestination } from '../../../git/git-helpers'
import { currentIdentity } from '../../../vault/acting-scope'
import { getSessionRecord } from '../../../data/sessions/session-records'
import { getWorkingBranch } from '../../../git/worktree-manager'
import { resolveHomePath } from '../../../platform/paths'
import { readPullRequestWatches, reopenPullRequestWatchChecks } from '../../../data/sessions/pull-request-watches'
import { checkAttempt } from '../../../prs/pr-watch-rules'
import { isCheckAccessFailure } from '../../../providers/github/check-runs'
import { invalidateAgentPullRequestReads } from '../../../providers/github/agent-pull-requests'
import { selectChecks } from '../../../providers/check-selection'
import { codeHostFor, pullRequestForHead, pushHeadFor, type CodeHost } from '../../../prs/code-host'
import { assertMayChangePullRequest } from '../../../prs/pr-access'
import { prIndex } from '../../../prs/pr-index'
import { providerForRepo } from '../../../providers/registry'
import type { PrSync } from '../../../prs/pr-sync'
import type { AgentTool, AgentToolContext } from './agent-tool'
import { linkCallerPullRequest } from './session-link-tools'
import { remoteTarget } from './session-tools'
import { encodeCursor, readAgentSummary, readSections, readCursor, pullRequestReadSection } from './pull-request-read'

interface PullRequestToolHost {
  resources: ResourceAccess
  prSync: Pick<PrSync, 'apply' | 'refresh'>
  isSessionBusy(sessionId: string): boolean
}

let host: PullRequestToolHost | undefined
const log = createLogger('PullRequestTools', 'pull-request-tools')
export function installPullRequestToolHost(next: PullRequestToolHost): void {
  host = next
}

interface AdmittedToolSession {
  cwd: string
  sessionId: string
  principal: Principal
  host: PullRequestToolHost
}

interface ToolSession extends AdmittedToolSession, CodeHost {
  syncHost: CodeHost
}

async function toolAdmission(context: AgentToolContext, writes: boolean): Promise<AdmittedToolSession> {
  const principal = workspaceToolAuthority()
  const sessionId = context.sessionId()
  if (!host || !principal || !sessionId) throw new Error('This tool requires an active Solus session.')
  const resources = host.resources
  const method = writes ? 'gitRunAction' : 'prGetDetail'
  const cwd = resolveHomePath(context.cwd)
  await assertRpcAccess(method, principal, [], resources)
  const permission = await authorize(principal, writes ? 'edit' : 'read', { kind: 'session', id: sessionId }, { name: method, resources })
  if (permission) throw new Error(permission.detail)
  assertPathInScope(method, principal, cwd)
  return { cwd, sessionId, principal, host }
}

async function toolCodeHost(cwd: string): Promise<{ scoped: CodeHost; syncHost: CodeHost } | null> {
  const target = await codeHostFor(cwd)
  if (!target) return null
  const review = target.provider.review.forCheckout?.(cwd) ?? target.provider.review
  return { scoped: { ...target, provider: { ...target.provider, review } }, syncHost: target }
}

async function toolSession(admission: AdmittedToolSession, input: { repository?: string; number?: number }): Promise<ToolSession> {
  const target = await toolCodeHost(admission.cwd)
  if (!target) throw new Error('This checkout has no supported code host.')
  const session = { ...admission, ...target.scoped, syncHost: target.syncHost }
  // Like upstream, a repository without a number does not retarget the
  // implicit branch PR.
  if (!input.repository || input.number === undefined || matchesRepository(session, input.repository)) return session
  const { operations, context } = await workspaceToolContext(admission.sessionId)
  const { items } = await operations.listSessionPullRequests(context, admission.sessionId)
  const repo = linkedPullRequestRepository(items, session.repo, input.repository, input.number)
  const provider = repo && providerForRepo(repo)
  if (!repo || !provider) throw new Error('This pull request does not belong to the selected project. Use a session in that repository or link the PR to this session.')
  const other = { repo, provider }
  return { ...session, ...other, syncHost: other }
}

const nonEmpty = z.string().trim().min(1)
const number = z.number().int().positive()
const environmentId = nonEmpty.optional().describe('The calling Solus host. Omit to use its checkout.')
const environmentFields = { environmentId }
const targetFields = {
  ...environmentFields,
  number: number.optional().describe("Default: this checkout's branch PR."),
  repository: nonEmpty.optional().describe('Repository as owner/name. Use with number for an explicitly linked PR.'),
}
const names = z.array(nonEmpty).min(1).max(25)
const cursor = nonEmpty.max(4096).optional()

function assertEnvironment(target?: string): void {
  if (target !== undefined && target !== getInstallationId()) {
    throw new Error('Use a session on the target host. This tool uses the calling session’s authenticated checkout.')
  }
}

function matchesRepository({ repo }: CodeHost, repository: string): boolean {
  const name = repository.toLowerCase()
  return name === `${repo.owner}/${repo.repo}`.toLowerCase() || name === repositoryKeyOf(repo)
}

function identity(pr: Pick<PullRequest, 'baseRepo' | 'number' | 'url'>) {
  return { host: pr.baseRepo.host, repository: `${pr.baseRepo.owner}/${pr.baseRepo.repo}`, number: pr.number, url: pr.url }
}

async function branchHead(session: ToolSession) {
  const branch = await getWorkingBranch(session.cwd)
  return branch ? pushHeadFor(session, session.cwd, branch) : null
}

async function targetNumber(session: ToolSession, input: { number?: number; repository?: string }, fresh = false): Promise<number> {
  const { repo, provider: { review } } = session
  if (input.number !== undefined) return input.number
  const head = await branchHead(session)
  const target = head && review.agentPullRequestNumberForHead
    ? await review.agentPullRequestNumberForHead(repo, head, fresh)
    : (await pullRequestForHead(session, head))?.number
  if (target === undefined) throw new Error('This branch has no known PR. Pass number, or open one with pull_request_create.')
  return target
}

async function locate(session: ToolSession, input: { number?: number; repository?: string }): Promise<PullRequest> {
  const target = await targetNumber(session, input, true)
  const { repo, provider: { review } } = session
  if (review.getPullRequest) return review.getPullRequest(repo, target)
  return (await review.getPullRequestOverview(repo, target)).pullRequest
}

async function assertMayWrite(session: ToolSession, number: number): Promise<void> {
  await assertMayChangePullRequest({ principal: session.principal, resources: session.host.resources }, repositoryKeyOf(session.repo), number)
}

async function syncMerge(session: ToolSession, pr: PullRequest): Promise<void> {
  if (pr.state === 'merged') {
    await completeTasksForMergedPullRequest(recordScopeOf(session.principal), repositoryKeyOf(session.repo), pr.number, {
      mergedAt: pr.updatedAt,
      isSessionBusy: session.host.isSessionBusy,
    })
  }
  await session.host.prSync.apply(session.syncHost, pr)
}

async function refreshMergedRows(session: ToolSession, numbers: number[]): Promise<void> {
  try {
    const rows = await session.provider.review.getPullRequests(session.repo, numbers)
    for (const row of rows.values()) if (row) await syncMerge(session, row)
  } catch (error) {
    // The forge already accepted the merge. A failed refresh must not invite another write.
    log.warn('pr_merge_refresh_failed', { sessionId: session.sessionId, numbers, error: String(error) })
  }
}

type Fields = NonNullable<Parameters<typeof z.object>[0]>
function tool<T extends Fields>(
  name: string,
  description: string,
  inputFields: T,
  writes: boolean,
  run: (input: z.output<z.ZodObject<T>>, session: ToolSession, context: AgentToolContext) => Promise<object>,
): AgentTool<T> {
  return {
    name, description, inputFields, strictInput: true, requiresApproval: writes,
    async execute(input, context) {
      try {
        context.abortSignal.throwIfAborted()
        const admission = await toolAdmission(context, writes)
        assertEnvironment(z.object({ environmentId }).parse(input).environmentId)
        const session = await toolSession(admission, z.object({ repository: targetFields.repository, number: targetFields.number }).parse(input))
        if (writes) invalidateAgentPullRequestReads(session.repo)
        const result = await run(input, session, context).finally(() => {
          if (writes) invalidateAgentPullRequestReads(session.repo)
        })
        return { ok: true, text: JSON.stringify(result), format: 'json' }
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

const prRead = tool(
  'pull_request_read', 'Read a PR’s state and check counts. Include adds detail.',
  {
    ...targetFields,
    include: z.array(pullRequestReadSection).optional().describe('Add body, check runs, threads, comments, or diff.'),
    includeResolved: z.boolean().optional(),
    cursor,
  }, false, async (input, session) => readSections(session, await targetNumber(session, input), input),
)

const listCursor = z.object({ scope: z.string(), cursor: nonEmpty })

const prList = tool(
  'pull_request_list', 'List PRs in this checkout repository, recently updated first.',
  {
    ...environmentFields,
    state: z.enum(['all', 'open', 'closed', 'merged']).default('open'),
    involvement: z.enum(['all', 'reviewing', 'authored']).default('all'),
    query: nonEmpty.max(200).optional(),
    limit: number.max(100).default(30),
    cursor,
  }, false, async (input, { repo, provider: { review } }) => {
    if (!review.agentPullRequestList) throw new Error('This code host cannot list PRs.')
    const scope = JSON.stringify([repositoryKeyOf(repo), input.state, input.involvement, input.query])
    const position = input.cursor ? readCursor(listCursor, input.cursor) : undefined
    if (position && position.scope !== scope) throw new Error('Use a cursor from this repository and filter.')
    const result = await review.agentPullRequestList(repo, { ...input, cursor: position?.cursor })
    return {
      ...result,
      truncated: result.nextCursor !== null,
      nextCursor: result.nextCursor ? encodeCursor({ scope, cursor: result.nextCursor }) : null,
    }
  },
)

const threadLinkFields = {
  ...environmentFields,
  threadId: nonEmpty.optional(),
  states: z.array(z.enum(['open', 'closed', 'merged'])).optional(),
  cursor,
}

const threadLinks: AgentTool<typeof threadLinkFields> = {
  name: 'list_thread_pull_requests',
  description: 'List a session’s PRs with last known state and whole stack chains for this page.',
  inputFields: threadLinkFields,
  strictInput: true,
  requiresApproval: false,
  async execute(input, agent) {
    try {
      agent.abortSignal.throwIfAborted()
      const session = await toolAdmission(agent, false)
      const sessionId = input.threadId ?? session.sessionId
      if (input.environmentId !== undefined && input.environmentId !== getInstallationId()) {
        if (!input.threadId) throw new Error('Pass threadId on the target host.')
        const remote = await remoteTarget(input.environmentId, session.sessionId)
        if ('error' in remote) throw new Error(remote.error)
        const links = await remote.host.call('list session pull requests', () => remote.host.api.sessionPullRequests(sessionId))
        return { ok: true, text: JSON.stringify(threadPullRequestPage(links, new Map(), input)), format: 'json' }
      }
      const permission = await authorize(session.principal, 'read', { kind: 'session', id: sessionId }, {
        name: 'list_thread_pull_requests', resources: session.host.resources,
      })
      if (permission) throw new Error(permission.detail)
      const { operations, context } = await workspaceToolContext(session.sessionId)
      const links = (await operations.listSessionPullRequests(context, sessionId)).items
      const checkout = links.length ? await toolCodeHost(session.cwd) : null
      const metadata = await readLinkedMetadata(links, checkout?.scoped)
      return { ok: true, text: JSON.stringify(threadPullRequestPage(links, metadata, input)), format: 'json' }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  },
}

async function pushForPullRequest(
  session: ToolSession, branch: string, destination: NonNullable<Awaited<ReturnType<typeof resolvePushDestination>>>,
  base: string | undefined, signal: AbortSignal, push: boolean,
) {
  const { repo, provider: { review }, cwd } = session
  const { remote, head } = destination
  const defaultBase = await review.defaultPullRequestBase?.(repo)
  const baseRef = base ?? defaultBase
  const isFork = repositoryKeyOf(head.repository) !== repositoryKeyOf(repo)
  if (!isFork && (head.branch === defaultBase || head.branch === baseRef)) {
    throw new Error('Check out a feature branch before creating a pull request.')
  }
  if (push) {
    const unavailable = await currentIdentity('a pull request push').gitUnavailableReason()
    if (unavailable) throw new Error(unavailable)
    await runAsync('git', ['push', '--set-upstream', '--', remote, `refs/heads/${branch}:refs/heads/${head.branch}`], cwd, { signal })
  }
  return { baseRef, isFork }
}

async function shouldPushPullRequestHead(cwd: string, remote: string, branch: string): Promise<boolean> {
  const upstream = await runAsync('git', ['rev-parse', '--symbolic-full-name', '@{upstream}'], cwd).catch(() => null)
  if (upstream?.trim() !== `refs/remotes/${remote}/${branch}`) return true
  return !await runAsync('git', ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'], cwd).then(() => true, () => false)
}

async function reusePullRequest(
  session: ToolSession, pr: PullRequest, input: { draft?: boolean; base?: string },
  branch: string, destination: NonNullable<Awaited<ReturnType<typeof resolvePushDestination>>>, push: boolean, signal: AbortSignal,
) {
  const shouldDraft = input.draft && !pr.draft
  if (push || shouldDraft) await assertMayWrite(session, pr.number)
  if (push) await pushForPullRequest(session, branch, destination, input.base, signal, true)
  if (!shouldDraft) return pr
  const current = push ? await locate(session, { number: pr.number }) : pr
  return session.provider.review.updatePullRequestLifecycle(session.repo, current.number, 'draft', current.headSha)
}

const prCreate = tool(
  'pull_request_create', 'Push this session’s branch, then open and link its PR, or return its open PR.',
  { ...environmentFields, title: nonEmpty, body: z.string(), base: nonEmpty.optional(), draft: z.boolean().optional(), private: z.boolean().optional() },
  true, async (input, session, context) => {
    if (input.private) throw new Error('GitHub has no private pull requests. Nothing was pushed. Leave out private to open a public one.')
    const { repo, provider, cwd, sessionId } = session
    const branch = await getWorkingBranch(cwd)
    if (!branch) throw new Error('Check out a branch before creating a pull request.')
    const destination = await resolvePushDestination(cwd, branch)
    if (!destination) throw new Error('Configure a push remote before creating a pull request.')
    const { head } = destination
    if (head.repository.host.toLowerCase() !== repo.host.toLowerCase()) throw new Error('The push remote must be on this repository’s code host.')
    const existing = () => pullRequestForHead(session, head)
    let pr = await existing()
    let created = false
    const push = await shouldPushPullRequestHead(cwd, destination.remote, head.branch)
    if (pr?.state === 'open') {
      pr = await reusePullRequest(session, pr, input, branch, destination, push, context.abortSignal)
    } else {
      const { baseRef, isFork } = await pushForPullRequest(session, branch, destination, input.base, context.abortSignal, push)
      try {
        pr = await provider.review.createPullRequest(repo, {
          baseRef, headRepo: isFork ? head.repository.repo : undefined,
          headRef: isFork ? `${head.repository.owner}:${head.branch}` : head.branch,
          title: input.title, body: input.body, draft: input.draft,
        })
        created = true
      } catch (error) {
        // Another caller can open the PR between the lookup and creation.
        pr = await existing().catch(() => undefined)
        if (pr?.state !== 'open') throw error
      }
    }
    prIndex.invalidate(repo)
    const linked = await linkCallerPullRequest({ cwd, sessionId, agentProvider: context.provider },
      () => workspaceToolContext(sessionId), repositoryKeyOf(repo), { target_id: pr.url, title: pr.title }, created ? 'created' : 'agent')
      .catch((error) => ({ ok: false, text: error instanceof Error ? error.message : String(error) }))
    await session.host.prSync.apply(session.syncHost, pr)
    if (!linked.ok) throw new Error(`The PR is open at ${pr.url}. Linking it to this session failed. ${linked.text}`)
    const record = await getSessionRecord(recordScopeOf(session.principal), sessionId)
    return {
      ...identity(pr), created,
      next: record?.delegation ? 'End your reply with: PR <full URL>, head <SHA>, checks and reviews <state>.' : undefined,
    }
  },
)

const updateFields = {
  ...targetFields, title: nonEmpty.optional(), body: z.string().optional(),
  ready: z.boolean().optional(), state: z.enum(['open', 'closed']).optional(),
  addLabels: names.optional(), removeLabels: names.optional(), requestReviewers: names.optional(),
}

async function updateMetadata(
  { repo, provider: { review } }: CodeHost, pr: PullRequest, input: z.output<z.ZodObject<typeof updateFields>>,
): Promise<PullRequest> {
  const { title, body, addLabels, removeLabels, requestReviewers } = input
  const { number, viewerPermissions: permissions } = pr
  const editsText = title !== undefined || body !== undefined
  if (editsText && permissions.editPullRequest === false) throw new Error('You cannot edit this pull request.')
  if ((addLabels || removeLabels) && !permissions.manageLabels) throw new Error('You cannot change labels on this pull request.')
  if (requestReviewers && !permissions.requestReviewers) throw new Error('You cannot request reviewers on this pull request.')

  const updated = editsText ? await review.updatePullRequest(repo, number, { title, body }) : pr
  if (addLabels || removeLabels) {
    if (!review.changeLabels) throw new Error('This code host cannot change PR labels.')
    const added = addLabels ?? []
    const names = new Map([...pr.labels.map((label) => label.name), ...added].map((name) => [name.toLowerCase(), name]))
    await review.changeLabels(repo, number, { add: added, remove: (removeLabels ?? []).flatMap((name) => names.get(name.toLowerCase()) ?? []) })
  }
  if (requestReviewers) await review.requestReviewers(repo, number, requestReviewers)
  return updated
}

const prUpdate = tool(
  'pull_request_update', 'Edit a PR’s title, body, labels, reviewers, open state, or draft state.',
  updateFields, true, async (input, session) => {
    const { repo, provider: { review } } = session
    const { title, body, ready, state, addLabels, removeLabels, requestReviewers } = input
    if ([title, body, ready, state, addLabels, removeLabels, requestReviewers].every((value) => value === undefined)) {
      throw new Error('Pass title, body, ready, state, addLabels, removeLabels, or requestReviewers.')
    }
    let pr = await locate(session, input)
    await assertMayWrite(session, pr.number)
    const number = pr.number
    try {
      pr = await updateMetadata(session, pr, input)
      if (ready !== undefined && ready === pr.draft) {
        pr = await review.updatePullRequestLifecycle(repo, number, ready ? 'ready' : 'draft', pr.headSha)
      }
      if (state !== undefined && state !== pr.state) {
        pr = await review.updatePullRequestLifecycle(repo, number, state === 'open' ? 'reopen' : 'close', pr.headSha)
      }
      await session.host.prSync.apply(session.syncHost, addLabels || removeLabels || requestReviewers ? await locate(session, { number }) : pr)
      return identity(pr)
    } finally {
      prIndex.invalidate(repo)
      session.host.prSync.refresh(session.syncHost)
    }
  },
)

async function setThreadResolution(
  { repo, provider: { review } }: CodeHost, threadId: string, resolved: boolean, replied: boolean,
): Promise<void> {
  try {
    if (resolved) await review.resolveThread(repo, threadId)
    else await review.unresolveThread(repo, threadId)
  } catch (error) {
    if (replied) throw new Error(`The reply was posted. Retry the resolution without body. ${String(error)}`)
    throw error
  }
}

const prRespond = tool(
  'pull_request_respond', 'Reply to, resolve, or reopen a review thread. Without reviewThreadId, comment on the PR.',
  { ...targetFields, reviewThreadId: nonEmpty.optional(), body: nonEmpty.optional(), resolved: z.boolean().optional() },
  true, async (input, session) => {
    const { repo, provider: { review } } = session
    const { reviewThreadId, body, resolved } = input
    if (resolved !== undefined && !reviewThreadId) throw new Error('resolved needs reviewThreadId.')
    if (!body && resolved === undefined) throw new Error('Pass body, or reviewThreadId with resolved.')
    const pr = await locate(session, input)
    await assertMayWrite(session, pr.number)
    if (body && !pr.viewerPermissions.comment) throw new Error('You cannot comment on this pull request.')
    if (resolved !== undefined && !pr.viewerPermissions.resolveThreads) throw new Error('You cannot change review thread resolution.')
    if (reviewThreadId) {
      const belongs = review.containsReviewThread ? await review.containsReviewThread(repo, pr.number, reviewThreadId)
        : (await review.listReviewThreads(repo, pr.number)).some(thread => thread.id === reviewThreadId)
      if (!belongs) throw new Error('The review thread does not belong to this pull request.')
    }
    try {
      if (body) {
        if (reviewThreadId) await review.replyToThread(repo, reviewThreadId, body)
        else await review.addIssueComment(repo, pr.number, body)
      }
      if (reviewThreadId && resolved !== undefined) {
        await setThreadResolution(session, reviewThreadId, resolved, !!body)
      }
      return { ...identity(pr), replied: body !== undefined, resolved: resolved ?? null }
    } finally {
      prIndex.invalidate(repo)
    }
  },
)

const reviewVerdicts = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' } as const
const reviewLineComment = z.object({
  path: nonEmpty, line: number, startLine: number.optional(), side: z.enum(['new', 'old']).optional(), body: nonEmpty,
})

async function validateReviewLines(host: CodeHost, pr: PullRequest, comments: z.output<typeof reviewLineComment>[]) {
  const { repo, provider: { review } } = host
  const baseSha = await review.getPullRequestDiffBase(repo, pr)
  const unplaced = new Set(comments)
  let cursor: string | undefined
  for (let page = 0; page < 10 && unplaced.size; page++) {
    const diff = await review.getPullRequestDiff(repo, pr, { repo, number: pr.number, baseSha, headSha: pr.headSha, cursor })
    const files = new Map(parsePatch(diff.patch).map(file => [file.filePath, file.hunks]))
    for (const comment of unplaced) {
      if (files.get(comment.path)?.some(hunk => {
        const old = comment.side === 'old'
        const start = old ? hunk.oldStart : hunk.newStart
        const length = old ? hunk.oldLines : hunk.newLines
        return (comment.startLine ?? comment.line) >= start && comment.line < start + length
      })) unplaced.delete(comment)
    }
    if (diff.nextCursor === null) break
    cursor = diff.nextCursor
  }
  const missing = unplaced.values().next().value
  if (missing) throw new Error(`${missing.path} line ${missing.startLine ?? missing.line} (${missing.side ?? 'new'} side) is not in this PR's diff. Comment on a changed line or one shown around it.`)
  return baseSha
}

const prReview = tool(
  'pull_request_review', 'Submit a PR review with optional line comments.',
  {
    ...targetFields, verdict: z.enum(['comment', 'approve', 'request-changes']), body: z.string().optional(),
    comments: z.array(reviewLineComment).max(50).optional(),
  }, true, async (input, session) => {
    const { repo, provider: { review } } = session
    const pr = await locate(session, input)
    await assertMayWrite(session, pr.number)
    if (!pr.viewerPermissions.reviewVerdicts.includes(input.verdict)) throw new Error('You cannot submit this review verdict.')
    if (input.verdict === 'approve' && pr.author.toLowerCase() === (await review.getViewer(repo)).toLowerCase()) {
      throw new Error('You cannot approve your own pull request.')
    }
    const comments = (input.comments ?? []).map((comment) => {
      if (comment.startLine !== undefined && comment.startLine > comment.line) throw new Error('startLine must be at or before line.')
      return { ...comment, side: comment.side === 'old' ? 'LEFT' as const : 'RIGHT' as const }
    })
    const baseSha = input.comments?.length ? await validateReviewLines(session, pr, input.comments) : undefined
    await review.createReview(repo, pr.number, {
      event: reviewVerdicts[input.verdict], body: input.body ?? '', commitId: pr.headSha, baseSha,
      comments,
    })
    prIndex.invalidate(repo)
    return identity(pr)
  },
)

async function mergeStack(
  session: ToolSession, pr: PullRequest, method: PrMergeMethod, expectedHeadSha: string,
): Promise<PullRequest['state']> {
  const { repo, provider: { review } } = session
  const stack = await review.getPullRequestStack(repo, pr.number, { headsOnly: true })
  const index = stack?.layers.findIndex((layer) => layer.number === pr.number) ?? -1
  if (!stack || index < 0) throw new Error('This PR is not in a native stack.')
  const layers = stack.layers.slice(0, index + 1).filter((layer) => layer.state !== 'merged')
  const expectedHeads = await Promise.all(layers.map(async (layer) => {
    await assertMayWrite(session, layer.number)
    if (!layer.headSha) throw new Error(`GitHub did not report the head of PR #${layer.number}.`)
    return { number: layer.number, headSha: layer.number === pr.number ? expectedHeadSha : layer.headSha }
  }))
  const result = await review.mergePullRequestStack(repo, { repo, number: pr.number, stackNumber: stack.number, method, expectedHeads }, { byStackNumber: true })
  await refreshMergedRows(session, result.layers)
  return result.status === 'queued' ? 'open' : 'merged'
}

const prMerge = tool(
  'pull_request_merge', 'Merge a PR if its head still matches expectedHeadSha. Set stack to land all open layers below it.',
  {
    ...targetFields, expectedHeadSha: nonEmpty, method: z.enum(['merge', 'squash', 'rebase', 'fast-forward']).optional(),
    auto: z.boolean().optional(), stack: z.boolean().optional(),
  }, true, async (input, session) => {
    if (input.stack && input.auto) throw new Error('A stack merge cannot wait with auto.')
    const { repo, provider: { review } } = session
    const pr = await locate(session, input)
    await assertMayWrite(session, pr.number)
    const expected = input.expectedHeadSha
    const sameHead = /^[0-9a-f]{7,}$/i.test(expected)
      ? pr.headSha.toLowerCase().startsWith(expected.toLowerCase()) : pr.headSha === expected
    if (!sameHead) throw new Error(`The head is now ${pr.headSha || 'unknown'}, not ${expected}. Review the new commits first.`)
    const action = input.stack ? 'merge-stack' : input.auto ? 'enable-auto-merge' : 'merge'
    if (!pr.viewerPermissions.actions.includes(action)) throw new Error('You do not have permission to merge this pull request this way.')
    const method = input.method ?? pr.capabilities.defaultMergeMethod ?? pr.capabilities.mergeMethods[0]
    if (!method || method === 'fast-forward' || !pr.capabilities.mergeMethods.includes(method)) {
      throw new Error('The repository does not allow that merge method.')
    }
    try {
      if (input.stack) {
        const state = await mergeStack(session, pr, method, pr.headSha)
        return { ...identity(pr), state }
      }
      if (review.agentMergePullRequest) {
        const state = await review.agentMergePullRequest(repo, pr, method, input.auto === true)
        await refreshMergedRows(session, [pr.number])
        return { ...identity(pr), state }
      }
      if (input.auto) {
        const updated = await review.enablePullRequestAutoMerge(repo, pr.number, method, pr.headSha)
        await syncMerge(session, updated)
        return { ...identity(pr), state: updated.state }
      }
      const result = await review.mergePullRequest(repo, pr.number, method, pr.headSha)
      if (!result.merged) throw new Error(result.message ?? 'The code host refused the merge.')
      await refreshMergedRows(session, [pr.number])
      return { ...identity(pr), state: 'merged' }
    } finally {
      prIndex.invalidate(repo)
      session.host.prSync.refresh(session.syncHost)
    }
  },
)

const ciFields = { ...targetFields, check: nonEmpty.optional() }

function checksFor(pr: AgentPullRequestSummary, name?: string) {
  return selectChecks(pr.checkRuns.map(run => ({ ...run.check, name: run.name })), name)
}

async function checkLog(session: ToolSession, pr: AgentPullRequestSummary, check: CheckItem, tailLines: number) {
  const result = { name: check.name, url: check.detailsUrl, log: null, truncated: false }
  const { provider: { review }, repo } = session
  if (!review.readCheckLog) return { ...result, detail: 'This code host cannot read check logs.' }
  try {
    return await review.readCheckLog(repo, check, pr.headSha, tailLines)
  } catch (error) {
    if (isCheckAccessFailure(error)) throw error
    return { ...result, detail: error instanceof Error ? error.message : String(error) }
  }
}

const ciLogs = tool(
  'ci_logs', 'Read the tail of a PR’s failing check logs, or one named check’s.',
  { ...ciFields, tailLines: number.max(2000).default(200) }, false, async (input, session) => {
    if (!session.provider.review.readCheckLog) throw new Error('This code host cannot read check logs.')
    const pr = await readAgentSummary(session, await targetNumber(session, input), { body: false, checksOnly: true })
    const checks = checksFor(pr, input.check)
    const shown = input.check === undefined ? checks.slice(0, 5) : checks
    const logs: Awaited<ReturnType<typeof checkLog>>[] = []
    for (let index = 0; index < shown.length; index += 4) {
      logs.push(...await Promise.all(shown.slice(index, index + 4).map(check => checkLog(session, pr, check, input.tailLines))))
    }
    return { ...identity({ ...pr, baseRepo: session.repo }), checks: [
      ...logs,
      ...checks.slice(shown.length).map(check => ({
        name: check.name, url: check.detailsUrl, log: null, truncated: false,
        detail: 'Not read, to keep the reply short. Ask for this check by name.',
      })),
    ] }
  },
)

const ciRerun = tool(
  'ci_rerun', 'Rerun a PR’s failing CI checks, or one named check.',
  ciFields, true, async (input, session) => {
    const { repo, provider: { review } } = session
    if (!review.rerunChecks) throw new Error('This code host cannot rerun checks.')
    const number = await targetNumber(session, input, true)
    await assertMayWrite(session, number)
    const pr = await readAgentSummary(session, number, { body: false, checksOnly: true, fresh: true })
    const checks = checksFor(pr, input.check)
    if (!checks.length) return { ...identity({ ...pr, baseRepo: repo }), checks: [] }
    const repository = repositoryKeyOf(repo)
    const original = (await readPullRequestWatches([session.sessionId])).find(watch => watch.repository === repository && watch.number === number)
    try {
      const result = await review.rerunChecks(repo, checks, pr.headSha)
      const restarted = checks.flatMap((check, index) => {
        const originalCheck = pr.checkRuns.find(run => run.check.id === check.id)?.check
        return result[index]?.rerun && originalCheck ? [{ name: originalCheck.name, previous: checkAttempt(originalCheck) }] : []
      })
      if (original && restarted.length) {
        // Preserve any newer remark watermark. A replacement watch or head is left alone.
        try {
          const watch = (await readPullRequestWatches([session.sessionId])).find(watch => watch.watchId === original.watchId)
          if (watch) await reopenPullRequestWatchChecks(watch, pr.headSha, restarted)
        } catch (error) {
          log.warn('pr_check_watch_reopen_failed', { sessionId: session.sessionId, number, error: String(error) })
        }
      }
      return { ...identity({ ...pr, baseRepo: repo }), checks: result }
    } finally {
      session.host.prSync.refresh(session.syncHost)
    }
  },
)

export const pullRequestTools = { prRead, prList, prCreate, prUpdate, prRespond, prReview, prMerge, ciLogs, ciRerun, threadLinks }
