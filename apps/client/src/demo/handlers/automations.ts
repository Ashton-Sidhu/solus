import { arg, optionalArg } from './args'
import type {
  AutomationAction,
  AutomationsChangedEvent,
  AutomationCreator,
  AutomationTrigger,
} from '@solus/contracts/types'
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
  const broadcast = (event: AutomationsChangedEvent) => backend.broadcast('automation.changed', event)
  backend.register('automationList', () => store.listAutomations())
  backend.register('automationRead', (args) => store.readAutomation(arg<string>(args, 0)))
  backend.register('automationListRuns', (args) => store.listAutomationRuns(arg<string>(args, 0)))
  backend.register('automationReadRun', (args) => store.readAutomationRun(arg<string>(args, 0), arg<string>(args, 1)))
  backend.register('automationSetEnabled', (args) => {
    const automation = store.updateAutomation(arg<string>(args, 0), { enabled: arg<boolean>(args, 1) })
    if (automation) broadcast({ kind: 'saved', automation })
    return automation
  })
  backend.register('automationUpdate', (args) => {
    const automation = store.updateAutomation(arg<string>(args, 0), arg<AutomationPatch>(args, 1))
    if (automation) broadcast({ kind: 'saved', automation })
    return automation
  })
  backend.register('automationCreate', (args) => {
    const name = arg<string>(args, 0)
    const action = arg<AutomationAction>(args, 1)
    const createdBy = arg<AutomationCreator>(args, 2)
    const enabled = optionalArg<boolean>(args, 3)
    const trigger = optionalArg<AutomationTrigger>(args, 4)
    const automation = store.createAutomation(name, action, createdBy, enabled, trigger)
    broadcast({ kind: 'saved', automation })
    return automation
  })
  backend.register('automationDelete', (args) => {
    const id = arg<string>(args, 0)
    const deleted = store.deleteAutomation(id)
    if (deleted) broadcast({ kind: 'deleted', automationId: id })
    return deleted
  })
  backend.register('automationRun', (args) => {
    const started = store.startAutomationRun(arg<string>(args, 0))
    if (!started) return null
    broadcast({ kind: 'run-started', ...started })
    setTimeout(() => {
      const finished = store.finishAutomationRun(started.automation.id, started.run.id)
      if (finished) broadcast({ kind: 'run-finished', ...finished })
    }, 2_000)
    return started.run
  })
}
