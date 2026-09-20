import { createLogger } from '../logger'
import type { ControlPlane } from '../control-plane'
import type { RunnerDelivery } from '../server/uplink/runner-delivery'
import { getSessionRecord } from '../sessions/session-records'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import { sharedPromptAckSchema, sharedPromptPollResponseSchema } from './shared-prompt'

const log = createLogger('main', 'shared-prompt-runner')

/** Only the authenticated workspace service assigns work. The runner never admits
 * guest sockets or accepts caller-supplied provider settings or paths. */
export function startSharedPromptRunner(delivery: RunnerDelivery, controlPlane: ControlPlane): () => void {
  let stopped = false
  let active = false
  const poll = async () => {
    const grant = delivery.currentGrant()
    if (stopped || active || !grant) return
    active = true
    try {
      const response = await delivery.call('/runner/shared-prompts/poll', { hostId: grant.hostId }, sharedPromptPollResponseSchema)
      if (response.kind !== 'ok' || stopped || delivery.currentGrant()?.organizationId !== grant.organizationId) return
      for (const command of response.body.commands) {
        let error: string | null = null
        try {
          if (command.expiresAt <= Date.now()) throw new Error('The prompt expired before dispatch.')
          if (!await getSessionRecord(LOCAL_ORGANIZATION_ID, command.sessionId)) throw new Error('This runner does not hold the session.')
          // Ask mode keeps tool permission decisions with the signed-in sharer/owner.
          await controlPlane.promptSession(command.sessionId, command.text, 'queue', { actor: command.actor, permissionMode: 'ask' })
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure)
        }
        await delivery.call('/runner/shared-prompts/result', { hostId: grant.hostId, requestId: command.requestId, error }, sharedPromptAckSchema)
      }
    } catch (error) {
      log.warn('shared_prompt_poll_failed', { error: error instanceof Error ? error.message : String(error) })
    } finally { active = false }
  }
  const timer = setInterval(() => { void poll() }, 2_000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
