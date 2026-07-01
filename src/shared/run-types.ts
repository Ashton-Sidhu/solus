import type { TaskProviderId } from './task-types'

export const MAX_RUN_LOG_LINES = 20_000

// 'completed' = a process that exited 0 (a one-shot build/test/script that
// finished, or a server that shut itself down cleanly). Distinct from
// 'stopped', which means the user cancelled it. 'error' = non-zero exit / crash.
export type RunState = 'stopped' | 'starting' | 'running' | 'completed' | 'error'

export interface RunStatus {
  repoRoot: string
  /** Stable id of the configured command, or 'auto' for the package.json fallback. */
  commandId: string
  name: string | null
  state: RunState
  command: string | null
  source: 'config' | 'package-dev' | 'package-start' | null
  /** Ports detected from process output (or the configured override), first is primary. */
  ports: number[]
  pid: number | null
  error: string | null
  /** Exit code of the last finished run; null while active or never run. */
  exitCode: number | null
  /** Epoch ms of the current run's spawn; null when not active. Drives the uptime readout. */
  startedAt: number | null
}

export interface RunProjectStatus {
  repoRoot: string
  runs: RunStatus[]
}

export type RunLogLevel = 'error' | 'warn' | 'success' | 'info'

export interface RunLogLine {
  /** Monotonic index within a single run lifetime; resets to 0 on (re)start. */
  seq: number
  level: RunLogLevel
  text: string
  /** Epoch ms when the line was captured. */
  ts: number
}

/** Live delta of newly captured log lines for one running command. */
export interface RunLogBatch {
  repoRoot: string
  commandId: string
  lines: RunLogLine[]
}

export interface RunCommandConfig {
  id: string
  name?: string
  command: string
  port?: number
}

export interface ProjectConfig {
  version: 1
  runCommands?: RunCommandConfig[]
  /** Which task provider this project uses. Absent = local (the default). */
  taskProvider?: TaskProviderId
  /** Provider scope. Auto-filled from the git remote for GitHub (`owner`/`repo`);
   *  later providers will carry their own selectors (Jira project key, Linear team). */
  taskProviderConfig?: { owner?: string; repo?: string }
}
