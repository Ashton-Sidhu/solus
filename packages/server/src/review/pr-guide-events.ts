import type { PrGuideStatusEvent, ReviewGuideStatusEvent } from '@solus/contracts/review'
import type { HostEventPublisher } from '../events/host-event-publisher'

/** Both the PR list and guide panes observe the same host job transitions. */
export function publishPrGuideStatus(events: HostEventPublisher, event: ReviewGuideStatusEvent): void {
  events.broadcast('review.guideStatusChanged', event)
  if (event.step) events.broadcast('review.progressChanged', { key: event.key, step: event.step })
  if (event.target?.kind !== 'pr') return
  const prEvent: PrGuideStatusEvent = {
    repoRoot: event.repoRoot, number: event.target.number, status: event.status,
  }
  if (event.status === 'ready') prEvent.metadata = {
    number: event.target.number, headSha: event.headSha,
    generatedAt: event.generatedAt ?? null, current: true,
  }
  events.broadcast('pr.guideStatusChanged', prEvent)
}
