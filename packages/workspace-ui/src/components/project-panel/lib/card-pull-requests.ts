import type { PullRequest } from '@solus/contracts/providers'
import { repositoryKeyFromRemoteUrl, repositoryKeyOf } from '@solus/contracts/repository-key'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { repositoryContext } from '../../../contexts/prs/linked-pr'

/** One pull request on the Git card, and where it is read and changed. */
export interface CardPullRequest {
  /** `host/owner/repo#number`: a number alone is not unique across repositories. */
  key: string
  pr: PullRequest
  /** This checkout's project for a pull request of its repository; the
   *  repository itself for any other, which the host reads by its key. */
  ctx: IpcContext
  /** `owner/repo` of a pull request outside this checkout's repository, null
   *  inside it. The card names it beside the number, and an agent handoff that
   *  needs a checkout of that repository is not offered. */
  otherRepository: string | null
}

/**
 * The open pull requests the Git card shows: the branch's own first, then
 * every one the session links, in link order, in whichever repository it is
 * (docs/plans/session-pull-requests.md).
 */
export function cardPullRequests(input: {
  branchPr: PullRequest | null
  links: readonly SessionPullRequestLink[]
  /** The repository the project learned from its pull requests. */
  projectRepository: string | null | undefined
  /** The checkout's primary remote, known before any pull request is read. */
  primaryRemoteUrl: string | null | undefined
  projectCtx: IpcContext
  /** The store's record of a pull request read through `ctx`. */
  prIn: (ctx: IpcContext, number: number) => PullRequest | null
}): CardPullRequest[] {
  const checkoutRepository = input.projectRepository?.toLowerCase()
    ?? (input.primaryRemoteUrl ? repositoryKeyFromRemoteUrl(input.primaryRemoteUrl) : null)
  const cards: CardPullRequest[] = input.branchPr
    ? [{
        key: `${repositoryKeyOf(input.branchPr.baseRepo)}#${input.branchPr.number}`,
        pr: input.branchPr,
        ctx: input.projectCtx,
        otherRepository: null,
      }]
    : []
  for (const link of input.links) {
    const key = `${link.repository}#${link.number}`
    if (cards.some((card) => card.key === key)) continue
    const isCheckoutRepository = link.repository === checkoutRepository
    const ctx = isCheckoutRepository ? input.projectCtx : repositoryContext(input.projectCtx, link.repository)
    const pr = input.prIn(ctx, link.number)
    if (pr?.state !== 'open') continue
    cards.push({
      key,
      pr,
      ctx,
      otherRepository: isCheckoutRepository ? null : link.repository.split('/').slice(1).join('/'),
    })
  }
  return cards
}

/** How the card names a pull request: `#412` in this checkout's repository,
 *  `site#52` in another. */
export function prReference(number: number, otherRepository: string | null): string {
  return `${otherRepository?.split('/').pop() ?? ''}#${number}`
}

/** One checks read for each context: the host answers checks per repository. */
export function checksReads(cards: readonly CardPullRequest[]): { ctx: IpcContext; numbers: number[] }[] {
  const byScope = new Map<string, { ctx: IpcContext; numbers: number[] }>()
  for (const card of cards) {
    const scope = projectScopeOf(card.ctx.session)
    const read = byScope.get(scope) ?? { ctx: card.ctx, numbers: [] }
    read.numbers.push(card.pr.number)
    byScope.set(scope, read)
  }
  return [...byScope.values()]
}
