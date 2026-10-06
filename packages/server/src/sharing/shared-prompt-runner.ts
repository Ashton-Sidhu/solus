import { createLogger } from '../logger'
import type { SessionRuntime } from '../execution/session-runtime'
import type { RunnerDelivery } from '../sync/runner-delivery'
import type { DeliveryDestination } from '../sync/outbox/outbox-store'
import { getSessionRecord } from '../data/sessions/session-records'
import { ANY_ORGANIZATION, GUEST_DEVICE_LABEL, type Principal } from '../admission/principal'
import type { Actor } from '../admission/actor'
import { parseUserKey } from '@solus/contracts/user'
import { sharedPromptAckSchema, sharedPromptPollResponseSchema, type SharedPromptCommand } from './shared-prompt'

const log = createLogger('main', 'shared-prompt-runner')

/**
 * Only the authenticated Solus API assigns work, and only for a session of the
 * organization the poll is made under: a runner polls each organization it acts
 * for someone in (plans/010-standard-oauth.md), and a command names a session that
 * belongs to that organization. The runner never admits guest sockets or accepts
 * caller-supplied provider settings or paths.
 */
export function startSharedPromptRunner(delivery: RunnerDelivery, sessionRuntime: SessionRuntime, hostId: () => string | null): () => void {
  let stopped = false
  const active = new Set<string>()
  const pollOrganization = async (destination: DeliveryDestination, hostId: string) => {
    const organizationId = destination.organizationId
    if (stopped || active.has(organizationId)) return
    active.add(organizationId)
    try {
      const response = await delivery.call(destination, '/runner/shared-prompts/poll', { hostId }, sharedPromptPollResponseSchema)
      if (response.kind !== 'ok' || stopped) return
      for (const command of response.body.commands) {
        let error: string | null = null
        try {
          if (command.expiresAt <= Date.now()) throw new Error('The prompt expired before dispatch.')
          const record = await getSessionRecord(ANY_ORGANIZATION, command.sessionId)
          if (!record) throw new Error('This runner does not hold the session.')
          if (record.organizationId !== organizationId) throw new Error('This session belongs to another organization.')
          // Ask mode keeps tool permission decisions with the signed-in sharer/owner.
          await sessionRuntime.dispatch.promptSession(command.sessionId, command.text, 'queue', { actor: sharedPromptActor(command, organizationId), permissionMode: 'supervised' })
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure)
        }
        await delivery.call(destination, '/runner/shared-prompts/result', { hostId, requestId: command.requestId, error }, sharedPromptAckSchema)
      }
    } catch (error) {
      log.warn('shared_prompt_poll_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    } finally { active.delete(organizationId) }
  }
  const poll = () => {
    const linkedHostId = hostId()
    if (!linkedHostId) return
    for (const destination of delivery.pollTargets()) void pollOrganization(destination, linkedHostId)
  }
  const timer = setInterval(poll, 2_000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}

/**
 * The link visitor behind a shared prompt, as the Solus API admitted them. The
 * wire names the seat by its user's key: the prompt runs on the visitor's own
 * account, or on the person who shared the link, never on the runner's login
 * unless the runner's own user shared it (plans/012 §3). The user is the one the
 * Solus API named, so the bubble reads the same on every client.
 */
function sharedPromptActor(command: SharedPromptCommand, organizationId: string): Actor {
  const author = parseUserKey(command.actor.userId)
  const principal: Extract<Principal, { kind: 'guest' }> = {
    kind: 'guest',
    organizationId,
    guestId: author.kind === 'guest' ? author.guestId : command.actor.userId,
    displayName: command.actor.displayName,
    deviceId: command.requestId,
    share: { resource: { kind: 'session', id: command.sessionId }, role: 'editor', sharedByUserId: command.actor.seatUserId, linkSecretHash: '' },
    expiresAt: command.expiresAt,
    deviceLabel: GUEST_DEVICE_LABEL,
  }
  if (author.kind === 'account') principal.accountUserId = author.accountId
  return { principal, user: { id: author, displayName: command.actor.displayName } }
}
