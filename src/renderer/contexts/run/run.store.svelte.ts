import { createContext } from 'svelte'
import { MAX_RUN_LOG_LINES, worktreeProjectRoot, type RunLogBatch, type RunLogLine, type RunProjectStatus, type RunStatus } from '../../../shared/types'

export class RunStore {
  /** repoRoot -> commandId -> status */
  projects = $state<Record<string, Record<string, RunStatus>>>({})
  /** repoRoot -> commandId -> live log buffer (streamed + backfilled). */
  logsByCommand = $state<Record<string, Record<string, RunLogLine[]>>>({})
  private repoRootByCwd = $state<Record<string, string>>({})

  apply(status: RunStatus): void {
    let byId = this.projects[status.repoRoot]
    if (!byId) {
      byId = {}
      this.projects[status.repoRoot] = byId
    }
    byId[status.commandId] = status
  }

  private applyProject(cwd: string, project: RunProjectStatus): void {
    this.repoRootByCwd[cwd] = project.repoRoot
    if (!this.projects[project.repoRoot]) {
      this.projects[project.repoRoot] = {}
    }
    // Always read back through the proxy so mutations go through Svelte's
    // signal system and deriveds (like runsFor) are notified immediately.
    const seen = new Set<string>()
    for (const run of project.runs) {
      this.projects[project.repoRoot][run.commandId] = run
      seen.add(run.commandId)
    }
    for (const id of Object.keys(this.projects[project.repoRoot])) {
      if (!seen.has(id)) delete this.projects[project.repoRoot][id]
    }
  }

  async status(cwd: string): Promise<RunProjectStatus | null> {
    if (!cwd || cwd === '~') return null
    const project = await window.solus.runStatus(cwd)
    this.applyProject(cwd, project)
    return project
  }

  async refreshProjectConfig(cwd: string): Promise<void> {
    const project = await this.status(cwd)
    if (!project) return

    const configRoot = this.configRootFor(project.repoRoot)
    const aliases = Object.entries(this.repoRootByCwd)
      .filter(([aliasCwd, repoRoot]) => aliasCwd !== cwd && this.configRootFor(repoRoot) === configRoot)
      .map(([aliasCwd]) => aliasCwd)

    await Promise.all(aliases.map((aliasCwd) => this.status(aliasCwd)))
  }

  async start(cwd: string, commandId: string): Promise<void> {
    if (!cwd || cwd === '~') return
    this.applyProject(cwd, await window.solus.runStart(cwd, commandId))
  }

  async stop(cwd: string, commandId: string): Promise<void> {
    if (!cwd || cwd === '~') return
    this.applyProject(cwd, await window.solus.runStop(cwd, commandId))
  }

  async restart(cwd: string, commandId: string): Promise<void> {
    if (!cwd || cwd === '~') return
    this.applyProject(cwd, await window.solus.runRestart(cwd, commandId))
  }

  /** Append a streamed delta. `seq === 0` marks a fresh (re)start — clear first. */
  applyLog(batch: RunLogBatch): void {
    const buf = this.ensureBuffer(batch.repoRoot, batch.commandId)
    for (const line of batch.lines) {
      if (line.seq === 0) buf.length = 0
      buf.push(line)
    }
    if (buf.length > MAX_RUN_LOG_LINES) buf.splice(0, buf.length - MAX_RUN_LOG_LINES)
  }

  /** Live, reactive log buffer for a command (undefined until status has resolved its repoRoot). */
  logsFor(cwd: string | null | undefined, commandId: string): RunLogLine[] | undefined {
    if (!cwd) return undefined
    const repoRoot = this.repoRootByCwd[cwd]
    if (!repoRoot) return undefined
    return this.logsByCommand[repoRoot]?.[commandId]
  }

  /** Seed from the backend ring buffer once, covering lines produced before we subscribed. */
  async backfillLogs(cwd: string, commandId: string): Promise<void> {
    if (!cwd || cwd === '~') return
    const repoRoot = this.repoRootByCwd[cwd]
    if (!repoRoot) return
    const existing = this.logsByCommand[repoRoot]?.[commandId]
    if (existing && existing.length > 0) return
    const lines = await window.solus.runLogs(cwd, commandId)
    // Re-check after the await: a stream delta may have arrived first.
    const buf = this.ensureBuffer(repoRoot, commandId)
    if (buf.length === 0) buf.push(...lines)
  }

  private ensureBuffer(repoRoot: string, commandId: string): RunLogLine[] {
    let byCmd = this.logsByCommand[repoRoot]
    if (!byCmd) {
      byCmd = {}
      this.logsByCommand[repoRoot] = byCmd
    }
    let buf = byCmd[commandId]
    if (!buf) {
      buf = []
      byCmd[commandId] = buf
    }
    return buf
  }

  private configRootFor(repoRoot: string): string {
    return worktreeProjectRoot(repoRoot)
  }

  runsFor(cwd: string | null | undefined): RunStatus[] | undefined {
    if (!cwd) return undefined
    const repoRoot = this.repoRootByCwd[cwd]
    if (!repoRoot) return undefined
    const byId = this.projects[repoRoot]
    if (!byId) return undefined
    return Object.values(byId)
  }
}

export const [getRunStore, setRunStore] = createContext<RunStore>()
