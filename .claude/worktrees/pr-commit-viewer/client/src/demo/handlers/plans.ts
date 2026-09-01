import type { PlanAnnotations } from '../../../../src/shared/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerPlansHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('listPlans', () => store.listPlans())
  backend.register('loadPlanContent', (args) => {
    const [sessionId, , planToolUseId] = args as [string, string, string]
    return store.loadPlanContent(sessionId, planToolUseId)
  })
  backend.register('loadPlanAnnotations', (args) => {
    const [sessionId, planToolUseId] = args as [string, string]
    return store.loadPlanAnnotations(sessionId, planToolUseId)
  })
  backend.register('savePlanAnnotations', (args) => ({ ok: store.savePlanAnnotations(args[0] as PlanAnnotations) }))
  backend.register('toggleBookmarkPlan', (args) => {
    const [sessionId, projectPath, cwd, planToolUseId, title] = args as [string, string, string, string, string]
    return store.toggleBookmarkPlan(sessionId, projectPath, cwd, planToolUseId, title)
  })
  backend.register('writePlanFile', (args) => {
    const [filePath, content] = args as [string, string]
    return store.writePlanFile(filePath, content)
      ? { ok: true }
      : { ok: false, error: `Plan file not found: ${filePath}` }
  })
}
