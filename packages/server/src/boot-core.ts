import { ControlPlane } from './control-plane'
import { createBackends } from './agents/backend-registry'
import { syncBundledPlugins } from './agents/plugins'
import { bootServer, type BootOptions, type BootedServer } from './server'
import { configureOtel } from './otel'
import { getHostConfig, getServerSettings } from './server/settings'
import { createLogger, isDebugEnabled } from './logger'
import { warmCliPath } from './cli-env'
import type { AgentId, IpcContext } from '@solus/contracts/types'

const DEFAULT_AGENT_ID: AgentId = 'claude-code'

const log = createLogger('main', 'boot-core.ts')

export interface BootCore {
  booted: BootedServer
  controlPlane: ControlPlane
  shutdown(): Promise<void>
}

export type BootCoreOptions = Omit<BootOptions, 'controlPlane' | 'agentIdFromContext'>

function agentIdFromContext(ctx?: IpcContext): AgentId {
  return ctx?.session.provider ?? ctx?.settings.activeAgent ?? DEFAULT_AGENT_ID
}

/** A blocked main thread shows up as a late timer. Debug builds log the gap
 *  when it frees up, so a stall lines up in `dev.log` against the RPC that
 *  preceded it. Off outside debug: one timer per 50 ms is not free. */
function watchEventLoopStalls(): void {
  if (!isDebugEnabled()) return
  const TICK_MS = 50
  const REPORT_AT_MS = 100
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    const stalledMs = Math.round(now - last - TICK_MS)
    if (stalledMs >= REPORT_AT_MS) log.warn('event_loop_stalled', { stalledMs })
    last = now
  }, TICK_MS).unref()
}

export async function bootCore(opts: BootCoreOptions = {}): Promise<BootCore> {
  watchEventLoopStalls()
  // The login-shell PATH probe runs off the main thread from here, so it is
  // warm before the first RPC spawns a provider. A caller that beats it pays a
  // synchronous shell on the main thread, and the first transcript page waits
  // behind that.
  void warmCliPath().catch((error) => log.warn('cli_path_warmup_failed', { error: error instanceof Error ? error.message : String(error) }))
  // The renderer's first connection waits on this whole function, so each phase
  // reports its cost: a slow boot then names its phase instead of one silent gap.
  const startedAt = performance.now()
  const phaseDone = (phase: 'plugins_synced' | 'otel_configured' | 'control_plane_ready' | 'server_booted'): void => {
    log.info('core_boot_phase', { phase, elapsedMs: Math.round(performance.now() - startedAt) })
  }
  // Link the app-bundled plugins into the state dir before any agent can run.
  // Both the desktop app and the standalone server boot through here, so the
  // headless host serves the same bundled skills as the desktop one.
  await syncBundledPlugins()
  phaseDone('plugins_synced')
  // Telemetry export follows the host's saved settings from the first span
  // onward. Both the desktop app and the standalone server boot through here,
  // so neither can end up exporting on a different rule from the other.
  await configureOtel(getHostConfig().config.otel)
  phaseDone('otel_configured')
  const controlPlane = new ControlPlane(createBackends())
  phaseDone('control_plane_ready')
  const booted = await bootServer({
    ...opts,
    controlPlane,
    agentIdFromContext,
  })
  phaseDone('server_booted')

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
