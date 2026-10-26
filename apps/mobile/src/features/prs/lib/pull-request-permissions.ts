// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestPermissions.ts and pullRequestActions.ts (MIT, see UPSTREAM.md).
import type { PrConversationItem, PrLifecycleAction, PrMergeMethod, PrReviewVerdict, PrStack, PrStackHead, PrStackLayer, PrStateAction, PullRequest } from '@solus/contracts/providers'
import { isOwnConversationComment } from '@solus/client-core/pull-request-comments'
import { canGiveVerdict } from './pr-presentation'

/**
 * What the person may do to a pull request now. Three things narrow it: what
 * the host and repository support (`capabilities`), what the person's account
 * may do (`viewerPermissions`), and the pull request's state. Every write also
 * needs a connected host. The merge rules follow the web client
 * (`workspace-ui/src/components/pr-review/lib/merge-readiness.ts`).
 */

export interface PullRequestPermissions {
  connected: boolean
  /** The verdicts a review may give; empty when no review can be submitted. */
  verdicts: PrReviewVerdict[]
  canInlineComment: boolean
  canComment: boolean
  canReply: boolean
  canResolve: boolean
  /** The merge methods in menu order, and the one a merge control starts on. */
  mergeMethods: PrMergeMethod[]
  defaultMergeMethod: PrMergeMethod | null
  canMerge: boolean
  /** Why a merge is not offered; null when it is. */
  mergeUnavailableReason: string | null
  canEnableAutoMerge: boolean
  canDisableAutoMerge: boolean
  canUpdateBranch: boolean
  /** The state changes allowed now, in menu order. */
  lifecycle: PrStateAction[]
  canRequestReviewers: boolean
  /** True when the host can list people to ask for a review. */
  hasReviewerCandidates: boolean
  canManageLabels: boolean
  /** The title and the description may be changed. As on the web client,
   *  the host decides the account's right when it gets the write. */
  canEditPullRequest: boolean
  /** True when an agent may push to the head: it lives in the base
   *  repository, and the person may change the pull request. */
  canUpdateHead: boolean
  /** A merged pull request can be reverted in a new pull request. */
  canRevert: boolean
  /** The person may let the held workflow runs of a fork pull request start. */
  canApproveWorkflows: boolean
}

const NONE: PullRequestPermissions = {
  connected: false, verdicts: [], canInlineComment: false, canComment: false, canReply: false, canResolve: false,
  mergeMethods: [], defaultMergeMethod: null, canMerge: false, mergeUnavailableReason: null, canEnableAutoMerge: false,
  canDisableAutoMerge: false, canUpdateBranch: false, lifecycle: [], canRequestReviewers: false, hasReviewerCandidates: false,
  canManageLabels: false, canEditPullRequest: false, canUpdateHead: false, canRevert: false, canApproveWorkflows: false,
}

/** The host finished the merge check and found it cannot merge. `mergeable:
 *  null` is still computing, so it says nothing. */
export function hasMergeConflicts(pr: Pick<PullRequest, 'state' | 'mergeable' | 'mergeStateStatus'>): boolean {
  return pr.state === 'open' && (pr.mergeStateStatus === 'dirty' || pr.mergeable === false)
}

function may(pr: PullRequest, action: PrLifecycleAction): boolean {
  return pr.capabilities.actions.includes(action) && pr.viewerPermissions.actions.includes(action)
}

/** The host grants `ready` to the people who may push to the head, so it
 *  answers "may update the head" without a second permission read. */
function mayUpdateHead(pr: PullRequest): boolean {
  return !pr.headRepo.isFork && pr.viewerPermissions.actions.includes('ready')
}

function lifecycleAllowed(pr: PullRequest, action: PrStateAction): boolean {
  if (!may(pr, action)) return false
  if (action === 'reopen') return pr.state === 'closed'
  if (pr.state !== 'open') return false
  if (action === 'ready') return pr.draft
  if (action === 'draft') return !pr.draft
  return true
}

export function mergeUnavailableReason(pr: PullRequest, connected: boolean): string | null {
  if (pr.state === 'merged') return 'This pull request is merged.'
  if (pr.state === 'closed') return 'Reopen this pull request before you merge it.'
  if (!connected) return 'Connect to this host to merge.'
  if (!pr.capabilities.actions.includes('merge')) return 'This host cannot merge here.'
  if (!pr.viewerPermissions.actions.includes('merge')) return 'Your account cannot merge this pull request.'
  if (pr.draft) return 'Mark this draft ready for review before you merge it.'
  if (hasMergeConflicts(pr)) return 'Resolve the conflicts with the base branch before you merge.'
  if (pr.capabilities.mergeMethods.length === 0) return 'This repository allows no merge method.'
  return null
}

type ReviewPermissions = Pick<PullRequestPermissions, 'verdicts' | 'canInlineComment' | 'canComment' | 'canReply' | 'canResolve'>
type MergePermissions = Pick<PullRequestPermissions, 'mergeMethods' | 'defaultMergeMethod' | 'canMerge' | 'mergeUnavailableReason' | 'canEnableAutoMerge' | 'canDisableAutoMerge' | 'canUpdateBranch'>

function reviewPermissions(pr: PullRequest, viewerLogin: string | null): ReviewPermissions {
  const verdicts = pr.state === 'open' ? pr.capabilities.reviewVerdicts.filter((verdict) => canGiveVerdict(pr, verdict, viewerLogin)) : []
  return {
    verdicts,
    canInlineComment: verdicts.length > 0 && pr.capabilities.inlineComments && pr.viewerPermissions.comment,
    canComment: pr.viewerPermissions.comment,
    canReply: pr.capabilities.threadReplies && pr.viewerPermissions.comment,
    canResolve: pr.capabilities.threadResolution && pr.viewerPermissions.resolveThreads,
  }
}

function mergePermissions(pr: PullRequest, connected: boolean): MergePermissions {
  const open = pr.state === 'open'
  const mergeMethods = pr.capabilities.mergeMethods
  const reason = mergeUnavailableReason(pr, connected)
  const armed = open && pr.autoMergeEnabled === true
  const landable = open && !pr.draft && !hasMergeConflicts(pr)
  // GitHub arms auto-merge only while the merge is held: blocked by a
  // requirement or behind its base. It refuses a pull request it could merge now.
  const held = pr.mergeStateStatus === 'blocked' || pr.mergeStateStatus === 'behind'
  return {
    mergeMethods,
    defaultMergeMethod: pr.capabilities.defaultMergeMethod ?? mergeMethods[0] ?? null,
    canMerge: reason === null,
    mergeUnavailableReason: reason,
    canEnableAutoMerge: landable && !armed && held && may(pr, 'enable-auto-merge') && mergeMethods.length > 0,
    canDisableAutoMerge: armed && may(pr, 'disable-auto-merge'),
    canUpdateBranch: open && pr.mergeStateStatus === 'behind' && mayUpdateHead(pr),
  }
}

export function pullRequestPermissions(pr: PullRequest | null, viewerLogin: string | null, connected: boolean): PullRequestPermissions {
  if (!pr) return { ...NONE, connected }
  const merge = mergePermissions(pr, connected)
  const facts = {
    hasReviewerCandidates: pr.capabilities.reviewerCandidates,
    canUpdateHead: mayUpdateHead(pr),
    mergeMethods: merge.mergeMethods,
    defaultMergeMethod: merge.defaultMergeMethod,
    mergeUnavailableReason: merge.mergeUnavailableReason,
  }
  // Every write needs the host now; without it only the facts remain.
  if (!connected) return { ...NONE, ...facts }
  return {
    ...reviewPermissions(pr, viewerLogin),
    ...merge,
    ...facts,
    connected,
    lifecycle: (['ready', 'draft', 'close', 'reopen'] as const).filter((action) => lifecycleAllowed(pr, action)),
    canRequestReviewers: pr.state === 'open' && pr.capabilities.reviewerRequests && pr.viewerPermissions.requestReviewers,
    canManageLabels: pr.capabilities.labelManagement && pr.viewerPermissions.manageLabels,
    canEditPullRequest: true,
    canRevert: pr.state === 'merged' && may(pr, 'revert'),
    canApproveWorkflows: pr.state === 'open' && may(pr, 'approve-workflows'),
  }
}

/** The person may delete a conversation comment they wrote, as on the web
 *  client; a write needs the host now. */
export function canDeleteComment(permissions: PullRequestPermissions, item: PrConversationItem, viewerLogin: string | null): boolean {
  return permissions.connected && isOwnConversationComment(item, viewerLogin)
}

/** GitHub keeps the viewed marks of the whole pull request when the host says
 *  so (`capabilities.viewedFiles`; an older host leaves it out). Otherwise, and
 *  for the changes of one commit, the marks stay on this device. */
export function viewedFilesOnHost(pr: PullRequest, commitSha: string | null): boolean {
  return pr.capabilities.viewedFiles === true && commitSha === null
}

/** A stack merge: the open layers from the bottom up to this pull request,
 *  and the heads the host must still find. `reason` says why it cannot run now. */
export interface StackMergePlan {
  stackNumber: number
  base: string
  layers: PrStackLayer[]
  expectedHeads: PrStackHead[]
  reason: string | null
}

/**
 * The stack merge through `pr`, as T3 Code plans it (`pullRequestStack.ts`).
 * Null when it is not offered: the pull request is not open or in no stack,
 * or the host or the account cannot merge a stack. A layer that is merged
 * already is not merged again.
 */
export function stackMergePlan(pr: PullRequest, stack: PrStack | null, connected: boolean, method: PrMergeMethod | null): StackMergePlan | null {
  if (!stack || pr.state !== 'open' || !may(pr, 'merge-stack')) return null
  const position = stack.layers.findIndex((layer) => layer.number === pr.number)
  const layers = position < 0 ? [] : stack.layers.slice(0, position + 1).filter((layer) => layer.state !== 'merged')
  const expectedHeads = layers.flatMap((layer) => layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [])
  const reason = !connected ? 'Connect to this host to merge the stack.'
    : position < 0 ? 'This pull request is not in the stack now. Read it again.'
      : layers.some((layer) => layer.state !== 'open') ? 'Reopen the closed layers below before you merge the stack.'
        : layers.some((layer) => layer.draft) ? 'Mark every layer to merge ready for review.'
          : expectedHeads.length !== layers.length ? 'Read the stack again before you merge it.'
            : method === null ? 'This repository allows no merge method.'
              : null
  return { stackNumber: stack.number, base: stack.base, layers, expectedHeads, reason }
}
