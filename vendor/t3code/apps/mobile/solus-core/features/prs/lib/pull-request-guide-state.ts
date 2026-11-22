// Adapted from T3 Code apps/mobile/src/features/pull-requests/guide/reviewGuideState.ts (MIT, see UPSTREAM.md).
import type { PullRequest } from '@solus/contracts/providers'
import { reviewGuideKeyForTarget, reviewGuideTargetId, type ReviewGuide, type ReviewGuideStatus, type ReviewGuideStatusEvent, type ReviewTarget } from '@solus/contracts/review'
import { describeGuideFailure } from '@solus/client-core/review-guide-failure'
import { shownValue, type LoadState } from '../pull-request-reads'

/**
 * The guide of one pull request, as the web client reads it
 * (`workspace-ui/src/contexts/prs/pr-guides.store.svelte.ts`): the host's
 * saved-guide status for the pull request target, and the guide itself. A
 * guide written for another head is outdated: it can still be read, and the
 * person can write it again for the new head.
 */

export type PrGuideTarget = Extract<ReviewTarget, { kind: 'pr' }>

export interface PullRequestGuide {
  /** The host's status for this target; null when it has no guide and no job. */
  status: ReviewGuideStatusEvent | null
  guide: ReviewGuide | null
}

export function prGuideTarget(pr: Pick<PullRequest, 'baseRepo' | 'number' | 'url' | 'baseSha' | 'headSha'>): PrGuideTarget {
  const { host, owner, repo } = pr.baseRepo
  return { kind: 'pr', host, owner, repo, number: pr.number, url: pr.url, baseSha: pr.baseSha, headSha: pr.headSha }
}

/** The key the host saves a pull request guide under. */
export function prGuideKey(target: PrGuideTarget): string {
  return reviewGuideKeyForTarget(target, '', null)
}

/** True when a status event is about this pull request. An event without a
 *  target is matched by its key. */
export function isGuideEventFor(event: ReviewGuideStatusEvent, target: PrGuideTarget): boolean {
  return event.target ? reviewGuideTargetId(event.target) === reviewGuideTargetId(target) : event.key === prGuideKey(target)
}

/** The status to show. A ready guide for another head is outdated; the list's
 *  `baseSha` is the base branch tip, not the guide's merge base, so only the
 *  head is compared. */
export function prGuideStatus(event: ReviewGuideStatusEvent | null, pr: Pick<PullRequest, 'headSha'>): ReviewGuideStatus | null {
  if (!event) return null
  return event.status === 'ready' && event.headSha !== pr.headSha ? 'outdated' : event.status
}

/** True when the host has a saved guide to read for this status. */
export function hasSavedGuide(event: ReviewGuideStatusEvent | null): boolean {
  return !!event && (event.status === 'ready' || event.status === 'outdated' || !!event.generatedAt)
}

/** Old failures do not follow a pull request onto a new head. */
export function reviewGuideState(value: PullRequestGuide | null, pr: Pick<PullRequest, 'headSha'>) {
  const guide = value?.guide ?? null
  const status = value?.status ?? null
  return {
    guide,
    running: status?.status === 'queued' || status?.status === 'generating',
    stale: guide !== null && guide.headSha !== pr.headSha,
    failure: status?.status === 'failed' && status.headSha === pr.headSha ? status.error ?? 'The guide could not be written.' : null,
  }
}

export type GuideNoticeKind = 'writing' | 'failed' | 'unavailable' | 'loading' | 'stale' | 'ready' | 'empty'

export interface GuideNotice {
  kind: GuideNoticeKind
  title: string
  description: string
  /** The raw error behind a failure, shown only on request. */
  details?: string | null
  action: string
}

/**
 * What the Guide tab says above the guide. A read that runs again does not
 * hide a guide already shown, and a new job does not show an old failure.
 */
export function guideNotice(input: {
  state: LoadState<PullRequestGuide>
  pr: Pick<PullRequest, 'headSha'>
  starting: boolean
  startError: string | null
}): GuideNotice {
  const value = shownValue(input.state)
  const { guide, running, stale, failure } = reviewGuideState(value, input.pr)
  if (input.starting || running) {
    return {
      kind: 'writing',
      title: guide ? 'Writing the guide again' : 'Writing guide',
      description: guide
        ? 'You can read this guide while the agent writes the new one.'
        : 'An agent reads the change and writes the tour. You can leave and come back when it is ready.',
      action: guide ? 'Writing again…' : 'Writing guide…',
    }
  }
  const error = input.startError ?? failure
  if (error) {
    const { summary, details } = describeGuideFailure(error)
    return { kind: 'failed', title: 'Could not write the guide', description: summary, details, action: 'Try again' }
  }
  if (input.state.kind === 'error') {
    return { kind: 'unavailable', title: 'Could not refresh the guide', description: input.state.message, action: 'Try again' }
  }
  if (!value) return { kind: 'loading', title: 'Review guide', description: 'Looking for a saved guide…', action: 'Loading guide…' }
  if (stale) {
    return {
      kind: 'stale',
      title: 'New changes since this guide',
      description: 'You can read the earlier guide, or write it again for the latest changes.',
      action: 'Write again',
    }
  }
  return {
    kind: guide ? 'ready' : 'empty',
    title: 'Review guide',
    description: 'Get a tour of the change, with code excerpts and notes on what needs a closer look.',
    action: 'Write guide',
  }
}
