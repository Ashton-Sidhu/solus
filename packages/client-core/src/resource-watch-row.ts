import { resourceWatchIsLive, type ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import type { BackgroundItem, BackgroundItemAction } from './background-item'

// A resource watch as a background work row (docs/plans/mcp-first-class.md §11.5).
// A watch can stay for a day, so its row shows no running clock, and it spins
// only while it opens or while a change is about to start the agent.

export const RESOURCE_WATCH_STOP: BackgroundItemAction = { id: 'stop', label: 'Stop', busyLabel: 'Stopping…', stops: true }

export function resourceWatchItem(watch: ResourceWatch): BackgroundItem {
  return {
    key: `resource-watch:${watch.id}`,
    label: `${watch.integrationName} · ${watch.name}`,
    detail: resourceWatchDetail(watch),
    state: resourceWatchState(watch),
    startedAt: null,
    actions: resourceWatchIsLive(watch) ? [RESOURCE_WATCH_STOP] : [],
    stopLabel: `Stop watching ${watch.name}`,
  }
}

function resourceWatchState(watch: ResourceWatch): BackgroundItem['state'] {
  switch (watch.state) {
    case 'starting':
    case 'changed':
      return 'running'
    case 'watching': return 'waiting'
    case 'needs-sign-in':
    case 'unreachable':
      return 'attention'
    case 'ended':
      switch (watch.endReason) {
        case 'expired':
        case 'limit':
          return 'ended'
        case 'stopped':
        case 'agent':
        case 'session-archived':
          return 'stopped'
        default: return 'failed'
      }
  }
}

function startedTheAgent(watch: ResourceWatch): string {
  return watch.wakes === 1 ? 'started the agent once' : `started the agent ${watch.wakes} times`
}

function resourceWatchDetail(watch: ResourceWatch): string {
  switch (watch.state) {
    case 'starting': return 'Starting the watch…'
    case 'watching':
      if (watch.message) return watch.message
      return watch.wakes ? `Watching for changes · ${startedTheAgent(watch)}` : 'Watching for changes'
    case 'changed': return watch.message ?? 'Changed · the agent starts soon'
    case 'needs-sign-in': return `Sign in to ${watch.integrationName} again`
    case 'unreachable': return `Could not reach ${watch.integrationName}`
    case 'ended':
      switch (watch.endReason) {
        case 'stopped': return 'Stopped'
        case 'agent': return 'Stopped by the agent'
        case 'limit': return `Ended: ${startedTheAgent(watch)}, its limit`
        case 'expired': return 'Ended after 24 hours'
        case 'session-archived': return 'Ended: the session was archived'
        default: return watch.message ?? 'Ended'
      }
  }
}

/** Which rows the conversation shows: the live ones, and the ones that ended after `since` (the last turn's start). */
export function shownResourceWatches(watches: readonly ResourceWatch[], since: number): ResourceWatch[] {
  return watches.filter((watch) => resourceWatchIsLive(watch) || watch.updatedAt >= since)
}
