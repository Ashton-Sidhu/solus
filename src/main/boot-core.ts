import { ControlPlane } from './control-plane'
import { RunManager } from './run/run-manager'
import { RunLogSubscriptions } from './run/run-log-subscriptions'
import { createBackends } from './agents/backend-registry'
import { bootServer, type BootOptions, type BootedServer } from './server'
import type { AgentId, IpcContext, RunStatus } from '../shared/types'

const DEFAULT_AGENT_ID: AgentId = 'claude-code'

export interface BootCore {
  booted: BootedServer
  controlPlane: ControlPlane
  runManager: RunManager
  shutdown(): Promise<void>
}

export type BootCoreOptions = Omit<BootOptions, 'controlPlane' | 'agentIdFromContext' | 'runManager'> & {
  onRunStatus?: (status: RunStatus) => void
}

function agentIdFromContext(ctx?: IpcContext): AgentId {
  return ctx?.session.provider ?? ctx?.settings.activeAgent ?? DEFAULT_AGENT_ID
}

export async function bootCore(opts: BootCoreOptions = {}): Promise<BootCore> {
  const { onRunStatus, ...serverOptions } = opts
  let booted: BootedServer | null = null
  const controlPlane = new ControlPlane(createBackends())
  const runLogSubscriptions = new RunLogSubscriptions()
  const runManager = new RunManager({
    broadcast: (status) => {
      booted?.events.broadcast('run.statusChanged', status)
      onRunStatus?.(status)
    },
    broadcastLog: (batch) => booted?.events.publish(
      runLogSubscriptions.clientIdsWatching(batch.repoRoot, batch.commandId),
      'run.logAppended',
      batch,
    ),
  })

  booted = await bootServer({
    ...serverOptions,
    controlPlane,
    agentIdFromContext,
    runManager,
    runLogSubscriptions,
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
