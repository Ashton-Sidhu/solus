import { backgroundCommandWake } from '@solus/client-core/background-command-wake'
import { pullRequestWatchWake } from '@solus/client-core/pull-request-watch-wake'
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
