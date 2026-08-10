import { ControlPlane } from './control-plane'
import { createBackends } from './agents/backend-registry'
import { bootServer, type BootOptions, type BootedServer } from './server'
import type { AgentId, IpcContext } from '../shared/types'

const DEFAULT_AGENT_ID: AgentId = 'claude-code'

export interface BootCore {
  booted: BootedServer
  controlPlane: ControlPlane
  shutdown(): Promise<void>
}

export type BootCoreOptions = Omit<BootOptions, 'controlPlane' | 'agentIdFromContext'>

function agentIdFromContext(ctx?: IpcContext): AgentId {
  return ctx?.session.provider ?? ctx?.settings.activeAgent ?? DEFAULT_AGENT_ID
}

export async function bootCore(opts: BootCoreOptions = {}): Promise<BootCore> {
  const controlPlane = new ControlPlane(createBackends())
  const booted = await bootServer({
    ...opts,
    controlPlane,
    agentIdFromContext,
  })

  let shutdownPromise: Promise<void> | null = null

  return {
    booted,
    controlPlane,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        controlPlane.shutdown()
        await booted.shutdown()
      })()
      return shutdownPromise
    },
  }
}
