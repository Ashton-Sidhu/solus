import { ControlPlane } from './control-plane'
import { RunManager } from './run/run-manager'
import { createBackends } from './agents/backend-registry'
import { bootServer, type BootOptions, type BootedServer } from './server'
import type { AgentId, IpcContext } from '../shared/types'

const DEFAULT_AGENT_ID: AgentId = 'claude-code'

export interface BootCore {
  booted: BootedServer
  controlPlane: ControlPlane
  runManager: RunManager
  shutdown(): Promise<void>
}

export type BootCoreOptions = Omit<BootOptions, 'controlPlane' | 'agentIdFromContext' | 'runManager'>

function agentIdFromContext(ctx?: IpcContext): AgentId {
  return ctx?.session.provider ?? ctx?.settings.activeAgent ?? DEFAULT_AGENT_ID
}

export async function bootCore(opts: BootCoreOptions = {}): Promise<BootCore> {
  let booted: BootedServer | null = null
  const controlPlane = new ControlPlane(createBackends())
  const runManager = new RunManager({
    broadcast: (status) => booted?.server.broadcast('run-status', status),
    broadcastLog: (batch) => booted?.server.broadcast('run-log', batch),
  })

  booted = await bootServer({
    ...opts,
    controlPlane,
    agentIdFromContext,
    runManager,
  })

  let shutdownPromise: Promise<void> | null = null

  return {
    booted,
    controlPlane,
    runManager,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        runManager.stopAll()
        controlPlane.shutdown()
        await booted!.shutdown()
      })()
      return shutdownPromise
    },
  }
}
