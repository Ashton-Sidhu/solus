import type {
  AutomationAction,
  AutomationsChangedEvent,
  AutomationCreator,
  AutomationTrigger,
} from '../../../../src/shared/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

type AutomationPatch = {
  name?: string
  enabled?: boolean
  favorite?: boolean
  action?: Partial<AutomationAction>
  trigger?: AutomationTrigger
}

export function registerAutomationsHandlers(backend: DemoServer, store: DemoStore): void {
  const broadcast = (event: AutomationsChangedEvent) => backend.broadcast('automations-changed', event)
  backend.register('automationList', () => store.listAutomations())
  backend.register('automationRead', (args) => store.readAutomation(args[0] as string))
  backend.register('automationListRuns', (args) => store.listAutomationRuns(args[0] as string))
  backend.register('automationReadRun', (args) => store.readAutomationRun(args[0] as string, args[1] as string))
  backend.register('automationSetEnabled', (args) => {
    const automation = store.updateAutomation(args[0] as string, { enabled: args[1] as boolean })
    if (automation) broadcast({ kind: 'saved', automation })
    return automation
  })
  backend.register('automationUpdate', (args) => {
    const automation = store.updateAutomation(args[0] as string, args[1] as AutomationPatch)
    if (automation) broadcast({ kind: 'saved', automation })
    return automation
  })
  backend.register('automationCreate', (args) => {
    const [name, action, createdBy, enabled, trigger] = args as [
      string,
      AutomationAction,
      AutomationCreator,
      boolean | undefined,
      AutomationTrigger | undefined,
    ]
    const automation = store.createAutomation(name, action, createdBy, enabled, trigger)
    broadcast({ kind: 'saved', automation })
    return automation
  })
  backend.register('automationDelete', (args) => {
    const id = args[0] as string
    const deleted = store.deleteAutomation(id)
    if (deleted) broadcast({ kind: 'deleted', automationId: id })
    return deleted
  })
  backend.register('automationRun', (args) => {
    const started = store.startAutomationRun(args[0] as string)
    if (!started) return null
    broadcast({ kind: 'run-started', ...started })
    setTimeout(() => {
      const finished = store.finishAutomationRun(started.automation.id, started.run.id)
      if (finished) broadcast({ kind: 'run-finished', ...finished })
    }, 2_000)
    return started.run
  })
}
