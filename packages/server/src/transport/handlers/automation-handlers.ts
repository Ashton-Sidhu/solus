import type { SolusServer } from '../server'
import { parseExecutionPreferences } from '../../execution/agents/run-input'
import { organizationForNew, recordScopeOf, type RecordScope } from '../../admission/principal'
import { attributionOf } from '../../admission/actor'
import {
  createAutomation,
  listAutomations,
  loadAutomation,
  updateAutomation,
  deleteAutomation,
  listRuns,
  listRecentRuns,
  loadRun,
  withAutomationRole,
} from '../../data/automations/automations-store'
import { triggerAutomationRun, cancelAutomationRun } from '../../execution/automations/automation-runner'
import { Task } from '../../data/tasks/task'
import { createLogger } from '../../logger'

const log = createLogger('main', 'automation-handlers')

async function linkAutomationToSessionTask(
  scope: RecordScope,
  automation: Awaited<ReturnType<typeof loadAutomation>>,
): Promise<void> {
  const sessionId = automation?.createdBy.kind === 'agent' ? automation.createdBy.sessionId : ''
  if (!automation || !sessionId) return
  await Task.linkSessionOutput(scope, sessionId, {
    kind: 'automation',
    targetKey: automation.id,
    title: automation.name,
  }).catch((error) => {
    log.warn('task_automation_link_failed', {
      sessionId,
      automationId: automation.id,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

/** RPC surface for the renderer to drive the same automation operations the
 *  agent tools expose. A call that names an automation passed the gate with the
 *  role it needs (`RESOURCE_VERB_OF_METHOD`); a list holds only what the caller
 *  may see (docs/plans/access-model.md §4 D4). */
export function registerAutomationHandlers(server: SolusServer): void {
  server.register('automationCreate', async (args, ctx) => {
    const [name, action, enabled, trigger, executionPreferences] = args
    // The creator comes from the verified caller, never from the request. Their
    // preferences choose behaviour, never authority.
    const preferences = parseExecutionPreferences(executionPreferences)
    const automation = await createAutomation(name, action, attributionOf(ctx.actor), enabled ?? true, trigger ?? { type: 'manual' }, preferences, organizationForNew(ctx.principal))
    await linkAutomationToSessionTask(recordScopeOf(ctx.principal), automation)
    return withAutomationRole(ctx.actor, automation)
  })

  server.register('automationList', async (_args, ctx) => listAutomations(ctx.actor))

  server.register('automationRead', async (args, ctx) => {
    const [id] = args
    return withAutomationRole(ctx.actor, await loadAutomation(id))
  })

  server.register('automationUpdate', async (args, ctx) => {
    const [id, patch] = args
    const { executionPreferences, ...rest } = patch
    const automation = await updateAutomation(id, executionPreferences === undefined ? rest : { ...rest, executionPreferences: parseExecutionPreferences(executionPreferences) })
    await linkAutomationToSessionTask(recordScopeOf(ctx.principal), automation)
    return withAutomationRole(ctx.actor, automation)
  })

  server.register('automationDelete', async (args) => {
    const [id] = args
    return deleteAutomation(id)
  })

  server.register('automationSetEnabled', async (args, ctx) => {
    const [id, enabled] = args
    const automation = await updateAutomation(id, { enabled })
    await linkAutomationToSessionTask(recordScopeOf(ctx.principal), automation)
    return withAutomationRole(ctx.actor, automation)
  })

  server.register('automationRun', async (args) => {
    const [id] = args
    const automation = await loadAutomation(id)
    if (!automation) return null
    if (!automation.enabled) return null
    return triggerAutomationRun(automation)
  })

  server.register('automationCancel', async (args) => {
    const [id] = args
    return cancelAutomationRun(id)
  })

  server.register('automationListRuns', async (args) => {
    const [id] = args
    return listRuns(id)
  })

  server.register('automationRecentRuns', async (args, ctx) => {
    const [perAutomation] = args
    return listRecentRuns(perAutomation, ctx.actor)
  })

  server.register('automationReadRun', async (args) => {
    const [automationId, runId] = args
    return loadRun(automationId, runId)
  })
}
