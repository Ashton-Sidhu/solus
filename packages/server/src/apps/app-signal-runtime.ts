import { parseUserKey } from '@solus/contracts/user'
import { HOST_ACTOR, unattendedActorFor, type Actor } from '../admission/actor'
import { ANY_ORGANIZATION } from '../admission/principal'
import type { AppRecord } from '../data/apps/app-store'
import { loadAutomation } from '../data/automations/automations-store'
import { getSessionRecord } from '../data/sessions/session-records'
import { SessionViewer } from '../data/sessions/session-states'
import { hasActiveRun, triggerAutomationRun } from '../execution/automations/automation-runner'
import type { SessionRuntime } from '../execution/session-runtime'
import { isHostUserKey } from '../host/host-user'
import type { AppSignalDeps } from './app-signals'

/**
 * What a signal action reaches in one host process (docs/plans/apps.md §8.4):
 * the session runtime for a prompt, and the automation runner for a run. Both
 * act as the app's owner, as a webhook's actions act as the webhook's owner
 * (`execution/webhooks/webhook-runtime.ts`).
 */

/** The person an app's unattended work runs as: its owner. The host's own user is the owner principal. */
function appOwnerActor(app: AppRecord): Actor {
  if (isHostUserKey(app.ownerKey)) return HOST_ACTOR
  const user = app.createdBy.kind === 'user' ? app.createdBy.user : { id: parseUserKey(app.ownerKey), displayName: app.ownerKey }
  const actor = unattendedActorFor(user, app.organizationId, 'App')
  if (!actor) throw new Error('A guest’s app does not run unattended work.')
  return actor
}

export function appSignalDeps(runtime: SessionRuntime): AppSignalDeps {
  return {
    sendToSession: async (app, sessionId, prompt) => {
      if (!(await getSessionRecord(ANY_ORGANIZATION, sessionId))) throw new Error('The target session does not exist.')
      if ((await new SessionViewer(sessionId, app.ownerKey).view()).archivedAt !== null) throw new Error('The target session is archived.')
      await runtime.dispatch.promptSession(sessionId, prompt, 'queue', { actor: appOwnerActor(app) })
    },
    runAutomation: async (_app, automationId, context) => {
      const automation = await loadAutomation(automationId)
      if (!automation || automation.archivedAt) throw new Error('The automation does not exist.')
      if (hasActiveRun(automationId)) return 'busy'
      await triggerAutomationRun(automation, { context })
      return 'started'
    },
  }
}
