import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { parseUserKey } from '@solus/contracts/user'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { HOST_ACTOR, unattendedActorFor, type Actor } from '../../admission/actor'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { isHostUserKey } from '../../host/host-user'
import { chatFolderFor } from '../../workspace'
import { expandHome } from '../../files/host-path'
import { getSessionRecord } from '../../data/sessions/session-records'
import { SessionViewer } from '../../data/sessions/session-states'
import { loadAutomation } from '../../data/automations/automations-store'
import type { WebhookRecord } from '../../data/webhooks/webhook-store'
import { hasActiveRun, triggerAutomationRun } from '../automations/automation-runner'
import { withActorScope } from '../seats/acting-identity'
import type { SessionRuntime } from '../session-runtime'
import { createWebhookActionRunner, type WebhookActionDeps, type WebhookActionRunner } from './action-runner'
import { createWebhookReceiver, type WebhookReceiver, type WebhookReceiverDeps } from './receiver'

/**
 * The webhooks of one host process: the receiver and the action runner, bound
 * to the session runtime and the automation runner. `boot-server.ts` makes one.
 */

/** What the host's link and its organization facts say (plan §2.5, §2.7, §3.7). */
export type WebhookHostFacts = Pick<WebhookReceiverDeps, 'hostId' | 'forwarderSecret' | 'isPausedByAdmin' | 'allowsUnverifiedWebhooks'>

/** The person a webhook runs as: its owner (plan §2.7). The host's own user is the owner principal. */
export function webhookActor(webhook: WebhookRecord): Actor {
  if (!webhook.ownerKey) return HOST_ACTOR
  if (isHostUserKey(webhook.ownerKey)) return HOST_ACTOR
  const user = webhook.createdBy.kind === 'user' ? webhook.createdBy.user : { id: parseUserKey(webhook.ownerKey), displayName: webhook.ownerKey }
  const actor = unattendedActorFor(user, webhook.organizationId, 'Webhook')
  if (!actor) throw new Error('A guest’s webhook does not run unattended work.')
  return actor
}

export function webhookActionDeps(runtime: SessionRuntime, facts: Pick<WebhookHostFacts, 'isPausedByAdmin'>): WebhookActionDeps {
  return {
    actorFor: webhookActor,
    isPausedByAdmin: facts.isPausedByAdmin,
    startSession: ({ prompt, action, actor }) => withActorScope(actor, async () => {
      const cwd = action.cwd === NEW_CHAT_DIRECTORY ? chatFolderFor(crypto.randomUUID(), actor.principal) : expandHome(action.cwd)
      const gitContext = action.useWorktree
        ? await runtime.checkouts.createNamed(cwd, prompt, runtime, new AbortController().signal, DEFAULT_EXECUTION_PREFERENCES)
        : null
      const session = await runtime.dispatch.startUnattendedSession({
        prompt,
        provider: action.agentProvider,
        modelId: action.modelId,
        reasoningEffort: action.reasoningEffort,
        cwd,
        gitContext,
        actor,
      })
      void session.done.catch(() => {})
      return { sessionId: session.sessionId }
    }),
    sendToSession: (sessionId, prompt, actor) => runtime.dispatch.promptSession(sessionId, prompt, 'queue', { actor }),
    sessionState: async (sessionId, webhook) => {
      if (!(await getSessionRecord(ANY_ORGANIZATION, sessionId))) return 'missing'
      const view = await new SessionViewer(sessionId, webhook.ownerKey).view()
      return view.archivedAt === null ? 'active' : 'archived'
    },
    runAutomation: async (automationId, context) => {
      const automation = await loadAutomation(automationId)
      if (!automation || automation.archivedAt) throw new Error('The automation does not exist.')
      if (hasActiveRun(automationId)) return { status: 'busy' }
      const run = await triggerAutomationRun(automation, { context })
      return { status: 'started', runId: run.id }
    },
  }
}

export interface WebhookServices {
  receiver: WebhookReceiver
  actions: WebhookActionRunner
}

export function createWebhookServices(runtime: SessionRuntime, facts: WebhookHostFacts): WebhookServices {
  const actions = createWebhookActionRunner(webhookActionDeps(runtime, facts))
  const receiver = createWebhookReceiver({
    ...facts,
    runDelivery: async (delivery) => { await actions.runDelivery(delivery) },
  })
  return { receiver, actions }
}
