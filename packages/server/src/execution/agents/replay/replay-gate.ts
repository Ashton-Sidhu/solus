import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { dataDir, isPackagedRuntime } from '../../../platform/paths'
import { platformServices } from '../../../platform/services'
import { createLogger } from '../../../logger'
import { ReplayBackend } from './replay-backend'
import { loadReplayScenarios } from './replay-scenario'

const log = createLogger('ReplayBackend', 'replay-gate.ts')

/** Where the scenario files live, relative to the repository root. Read from
 *  disk, never bundled: a packaged app or a released server carries no copy. */
const SCENARIOS_FROM_REPO_ROOT = 'packages/server/src/execution/agents/replay/scenarios'

/** What decides whether this process offers the replay provider. */
export interface ReplayGateFacts {
  /** A packaged desktop app, or a released standalone server (its launcher sets SOLUS_INSTALL_DIR). */
  packaged: boolean
  /** The desktop app run from source (`bun run dev`): Electron that is not packaged. */
  electronFromSource: boolean
  /** The folder this server keeps its data in. */
  dataDir: string
  /** The default live folder, `~/.solus`. */
  liveDataDir: string
  /** The scenario files were found, which only a source checkout has. */
  hasScenarios: boolean
}

/**
 * The replay provider is for development only (docs/replay-provider.md):
 *
 * - Never in a packaged app or a released server.
 * - Never without the scenario files, which only a source checkout has.
 * - Always in the desktop app run from source: that is unmistakably a developer.
 * - A server run from source in some other way (the standalone server, the Lab,
 *   a test) offers it only on a data folder other than the live `~/.solus`, so
 *   a source server pointed at a person's real data does not grow a fake agent.
 */
export function replayBackendAllowed(facts: ReplayGateFacts): boolean {
  if (facts.packaged || !facts.hasScenarios) return false
  if (facts.electronFromSource) return true
  return resolve(facts.dataDir) !== resolve(facts.liveDataDir)
}

/** The scenario folder of this source checkout, or null when there is none. */
export function replayScenarioDirectory(): string | null {
  const roots = [platformServices().appInfo?.appPath, process.cwd()]
  for (const root of roots) {
    if (!root) continue
    const directory = join(root, SCENARIOS_FROM_REPO_ROOT)
    if (existsSync(directory)) return directory
  }
  return null
}

/** The facts of this process. */
export function currentReplayGateFacts(scenarioDirectory: string | null): ReplayGateFacts {
  const appInfo = platformServices().appInfo
  return {
    packaged: isPackagedRuntime(),
    electronFromSource: !!appInfo && !appInfo.isPackaged,
    dataDir: dataDir(),
    liveDataDir: join(homedir(), '.solus'),
    hasScenarios: scenarioDirectory !== null,
  }
}

/** The development replay provider, where this process allows it (replayBackendAllowed). */
export function createReplayBackend(): ReplayBackend | null {
  const scenarioDirectory = replayScenarioDirectory()
  const facts = currentReplayGateFacts(scenarioDirectory)
  if (!scenarioDirectory || !replayBackendAllowed(facts)) return null
  try {
    const backend = new ReplayBackend({ scenarios: loadReplayScenarios(scenarioDirectory), historyDirectory: join(dataDir(), 'replay-sessions') })
    log.info('replay_backend_registered', { scenarioDirectory, scenarios: backend.metadata.models.length })
    return backend
  } catch (error) {
    // A broken scenario file must not stop a development server from starting.
    log.error('replay_backend_failed', { scenarioDirectory, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
