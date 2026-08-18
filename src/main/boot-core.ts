import { ControlPlane } from './control-plane'
import { createBackends } from './agents/backend-registry'
import { syncBundledPlugins } from './agents/plugins'
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
  // Link the app-bundled plugins into the state dir before any agent can run.
  // Both the desktop app and the standalone server boot through here, so the
  // headless host serves the same bundled skills as the desktop one.
  await syncBundledPlugins()
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
        // Session cancellation above drives status transitions whose attention
        // writes are coalesced and asynchronous; drain them before the process
        // is allowed to exit so the persisted file reflects the final state.
        await controlPlane.attention.flushPersist()
        await booted.shutdown()
      })()
      return shutdownPromise
    },
  }
}
