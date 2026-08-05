import type { SolusServer } from '../server'
import type { AutomationAction, AutomationCreator, AutomationTrigger } from '../../../shared/types'
import {
  createAutomation,
  listAutomations,
  loadAutomation,
  updateAutomation,
  deleteAutomation,
  listRuns,
  loadRun,
} from '../../automations/automations-store'
import { triggerAutomationRun, cancelAutomationRun } from '../../automations/automation-runner'
import { Task } from '../../tasks/task'
import { createLogger } from '../../logger'

const log = createLogger('main', 'automation-handlers')

async function linkAutomationToSessionTask(automation: Awaited<ReturnType<typeof loadAutomation>>): Promise<void> {
  const sessionId = automation?.createdBy.sessionId
  if (!automation || !sessionId) return
  await Task.linkArtifactForSession(sessionId, {
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
 *  agent tools expose. Phase 1: run-now only (no scheduling). */
export function registerAutomationHandlers(server: SolusServer): void {
  server.register('automationCreate', async (args) => {
    const [name, action, createdBy, enabled, trigger] = args as [
      string,
      AutomationAction,
      AutomationCreator,
      boolean | undefined,
      AutomationTrigger | undefined,
    ]
    const automation = await createAutomation(name, action, createdBy, enabled ?? true, trigger ?? { type: 'manual' })
    await linkAutomationToSessionTask(automation)
    return automation
  })

  server.register('automationList', async () => listAutomations())

  server.register('automationRead', async (args) => {
    const [id] = args as [string]
    return loadAutomation(id)
  })

  server.register('automationUpdate', async (args) => {
    const [id, patch] = args as [
      string,
      { name?: string; enabled?: boolean; favorite?: boolean; action?: Partial<AutomationAction>; trigger?: AutomationTrigger },
    ]
    const automation = await updateAutomation(id, patch)
    await linkAutomationToSessionTask(automation)
    return automation
  })

  server.register('automationDelete', async (args) => {
    const [id] = args as [string]
    return deleteAutomation(id)
  })

  server.register('automationSetEnabled', async (args) => {
    const [id, enabled] = args as [string, boolean]
    const automation = await updateAutomation(id, { enabled })
    await linkAutomationToSessionTask(automation)
    return automation
  })

  server.register('automationRun', async (args) => {
    const [id] = args as [string]
    const automation = await loadAutomation(id)
    if (!automation) return null
    if (!automation.enabled) return null
    return triggerAutomationRun(automation)
  })

  server.register('automationCancel', async (args) => {
    const [id] = args as [string]
    return cancelAutomationRun(id)
  })

  server.register('automationListRuns', async (args) => {
    const [id] = args as [string]
    return listRuns(id)
  })

  server.register('automationReadRun', async (args) => {
    const [automationId, runId] = args as [string, string]
    return loadRun(automationId, runId)
  })
}
