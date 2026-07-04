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
    return createAutomation(name, action, createdBy, enabled ?? true, trigger ?? { type: 'manual' })
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
    return updateAutomation(id, patch)
  })

  server.register('automationDelete', async (args) => {
    const [id] = args as [string]
    return deleteAutomation(id)
  })

  server.register('automationSetEnabled', async (args) => {
    const [id, enabled] = args as [string, boolean]
    return updateAutomation(id, { enabled })
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
