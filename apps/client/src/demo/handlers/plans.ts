import { arg } from './args'
import type { PlanAnnotations } from '@solus/contracts/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerPlansHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('listPlans', () => store.listPlans())
  backend.register('loadPlanContent', (args) => {
    const sessionId = arg<string>(args, 0)
    const planToolUseId = arg<string>(args, 2)
    return store.loadPlanContent(sessionId, planToolUseId)
  })
  backend.register('loadPlanAnnotations', (args) => {
    const sessionId = arg<string>(args, 0)
    const planToolUseId = arg<string>(args, 1)
    return store.loadPlanAnnotations(sessionId, planToolUseId)
  })
  backend.register('savePlanAnnotations', (args) => ({ ok: store.savePlanAnnotations(arg<PlanAnnotations>(args, 0)) }))
  backend.register('toggleBookmarkPlan', (args) => {
    const [sessionId, projectPath, cwd, planToolUseId, title] = [0, 1, 2, 3, 4].map((index) => arg<string>(args, index))
    return store.toggleBookmarkPlan(sessionId, projectPath, cwd, planToolUseId, title)
  })
  backend.register('writePlanFile', (args) => {
    const filePath = arg<string>(args, 0)
    const content = arg<string>(args, 1)
    return store.writePlanFile(filePath, content)
      ? { ok: true }
      : { ok: false, error: `Plan file not found: ${filePath}` }
  })
}
