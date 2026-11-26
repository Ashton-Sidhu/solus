import { backgroundCommandWake } from '@solus/client-core/background-command-wake'
import { pullRequestWatchWake, pullRequestWatchWakeSummary } from '@solus/client-core/pull-request-watch-wake'
import { mcpTaskWake } from '@solus/contracts/integrations/mcp-task'
import { resourceWatchWake } from '@solus/contracts/integrations/resource-watch'
import type { Message } from '@solus/contracts/types'

/**
 * A prompt the host sent as a caption about work the agent started — a
 * watched pull request's news, a background command that finished, an MCP
 * task that ended, a watched MCP resource that changed — rather than a person's words. Known by its origin while live, and by its text once
 * reloaded: a history row keeps no origin. An automation's prompt is not a
 * notice; it is the words someone scheduled, and it stays a bubble.
 */
export type HostNoticeKind = 'pull-request-watch' | 'background-command' | 'mcp-task' | 'resource-watch'

export function hostNoticeKind(message: Pick<Message, 'via' | 'content'>): HostNoticeKind | null {
  if (message.via === 'pull-request-watch' || message.via === 'background-command' || message.via === 'mcp-task' || message.via === 'resource-watch') return message.via
  if (pullRequestWatchWake(message.content)) return 'pull-request-watch'
  if (backgroundCommandWake(message.content)) return 'background-command'
  if (mcpTaskWake(message.content)) return 'mcp-task'
  if (resourceWatchWake(message.content)) return 'resource-watch'
  return null
}

/** The monitor activity that T3 displays for a watch wake. */
export function watchNotification(text: string, via?: Message['via']) {
  const watch = pullRequestWatchWake(text)
  if (watch) {
    const failed = (watch.ended && !watch.news.length) || watch.news.some(({ kind }) => kind === 'checks-failed' || kind === 'conflicting')
    const completed = watch.news.length > 0 && watch.news.every(({ kind }) => kind === 'merged' || kind === 'checks-passed' || kind === 'all-checks-passed')
    return {
      source: { kind: 'monitor' }, outcome: failed ? 'failed' : completed ? 'completed' : 'updated',
      summary: `#${watch.number}: ${pullRequestWatchWakeSummary(watch) || 'updated'}`,
    } as const
  }
  const resource = resourceWatchWake(text)
  if (resource || via === 'resource-watch' || via === 'pull-request-watch') {
    return { source: { kind: 'monitor' }, outcome: 'updated', summary: resource?.label ?? (via === 'resource-watch' ? 'Resource watch updated' : 'Pull request updated') } as const
  }
  return null
}
