import type { HostEventPublisher } from '../../events/host-event-publisher'
import { cancelPrompt, enqueuePrompt, listQueue } from '../../sessions/prompt-queue'
import { isHostAdmin, organizationOf, principalDisplayName, principalOwnerId } from '../principal'
import type { SolusServer } from '../server'
import { isWorkspaceMode } from '../workspace-mode'

export interface PromptQueueDeps {
  events: HostEventPublisher
}

/**
 * The durable prompt queue's RPC face (docs/plans/cloud-service-model.md §4).
 * A prompt waits only on the workspace service: a host that runs the session
 * itself prompts it live through `promptSession`, so enqueueing there is a
 * client mistake and is refused. Access is the policy's (`sessionPromptEnqueue`
 * needs an editor of the session, the list a viewer); withdrawing is the
 * author's or an administrator's, checked here.
 */
export function registerPromptQueueHandlers(server: SolusServer, deps: PromptQueueDeps): void {
  const { events } = deps

  server.register('sessionPromptEnqueue', async ([request], ctx) => {
    if (!isWorkspaceMode()) throw new Error('Prompts wait only on the cloud workspace; this host runs the session itself.')
    const authorUserId = principalOwnerId(ctx.principal)
    if (!authorUserId) throw new Error('A queued prompt needs a person as its author.')
    const text = request.text.trim()
    if (!text) throw new Error('A queued prompt needs text.')
    const prompt = await enqueuePrompt(organizationOf(ctx.principal), {
      sessionId: request.sessionId,
      authorUserId,
      authorDisplayName: principalDisplayName(ctx.principal),
      text,
    })
    void events.broadcast('session.promptQueueChanged', { sessionId: prompt.sessionId })
    return prompt
  })

  server.register('sessionPromptQueueList', async ([sessionId], ctx) => listQueue(organizationOf(ctx.principal), sessionId))

  server.register('sessionPromptQueueCancel', async ([{ queueId }], ctx) => {
    const cancelled = await cancelPrompt(organizationOf(ctx.principal), queueId, principalOwnerId(ctx.principal) ?? '', isHostAdmin(ctx.principal))
    if (!cancelled) return { cancelled: false }
    void events.broadcast('session.promptQueueChanged', { sessionId: cancelled.sessionId })
    return { cancelled: true }
  })
}
