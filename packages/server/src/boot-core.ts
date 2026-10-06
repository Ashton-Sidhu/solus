import { join } from 'node:path'
import { dataDir } from './platform/paths'
import { SessionRuntime } from './execution/session-runtime'
import { createBackends } from './execution/agents/backend-registry'
import { syncBundledPlugins } from './execution/agents/plugins'
import { bootServer, type BootOptions, type BootedServer } from './boot-server'
import { configureOtel } from './otel'
import { getHostConfig, getServerSettings } from './host/settings'
import { createLogger, isDebugEnabled } from './logger'
import { warmCliPath } from './cli-env'
import { startSessionIndexer, stopSessionIndexer } from './db/session-indexer'
import type { AgentId, IpcContext } from '@solus/contracts/types'

const DEFAULT_AGENT_ID: AgentId = 'claude-code'

const log = createLogger('main', 'boot-core.ts')

export interface BootCore {
  booted: BootedServer
  sessionRuntime: SessionRuntime
  /** Start the transcript index sweep, once. Needed only after `deferSessionIndex`. */
  startSessionIndex(): void
  shutdown(): Promise<void>
}

export type BootCoreOptions = Omit<BootOptions, 'sessionRuntime' | 'agentIdFromContext'> & {
  /** Leave the disk-heavy index sweep for the caller to start: the desktop
   *  starts it after its window first paints. Every other host starts it here. */
  deferSessionIndex?: boolean
}

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
  const sessionRuntime = new SessionRuntime(createBackends(), { queueDirectory: join(dataDir(), 'session-queues') })
  phaseDone('control_plane_ready')
  const booted = await bootServer({
    ...opts,
    sessionRuntime,
    agentIdFromContext,
  })
  phaseDone('server_booted')
  // Recovery belongs to the execution host, after tools and seats are ready.
  // Do not make client connection or first paint wait on provider setup.
  void sessionRuntime.restarts.recoverSessionsAfterRestart().catch((error) => {
    log.error('restart_recovery_failed', { error: String(error) })
  })

  // Session lists and search are answered from the index, so every machine
  // keeps one. A host's first sweep reads its transcripts into it.
  let sessionIndexStarted = false
  const startSessionIndex = () => {
    if (sessionIndexStarted) return
    sessionIndexStarted = true
    startSessionIndexer()
  }
  if (!opts.deferSessionIndex) startSessionIndex()

  let shutdownPromise: Promise<void> | null = null

  return {
    booted,
    sessionRuntime,
    startSessionIndex,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        stopSessionIndexer()
        sessionRuntime.shutdown()
        // Session cancellation above drives status transitions whose attention
        // writes are coalesced and asynchronous; drain them before the process
        // is allowed to exit so the persisted file reflects the final state.
        await sessionRuntime.attention.flushPersist()
        await booted.shutdown()
      })()
      return shutdownPromise
    },
  }
}
