import { connectionsStore, projectsStore, toasts } from '../../contexts'
import type {
  SetupAgentAuthCheckResult,
  SetupGithubRepo,
  SetupLogEvent,
  SetupStatusEvent,
  SetupStepStatus,
  SetupStreamStep,
} from '../../../shared/types'

const LOG_LIMIT = 500

function emptyLogs(): Record<SetupStreamStep, string[]> {
  return {
    'install-claude': [],
    'install-codex': [],
    clone: [],
  }
}

export class ServerSetupStore {
  collapsed = $state(false)
  serverNameDraft = $state('')
  serverNameDirty = $state(false)
  savingName = $state(false)

  logs = $state<Record<SetupStreamStep, string[]>>(emptyLogs())
  statuses = $state<Partial<Record<SetupStreamStep, SetupStepStatus>>>({})

  authCheck = $state<SetupAgentAuthCheckResult | null>(null)
  repos = $state<SetupGithubRepo[]>([])
  reposLoaded = $state(false)
  reposLoading = $state(false)
  reposConnected = $state<boolean | null>(null)
  clonedProjectPath = $state<string | null>(null)

  private listenerCount = 0
  private unlistenLog: (() => void) | null = null
  private unlistenStatus: (() => void) | null = null

  listen(): () => void {
    this.listenerCount++
    if (!this.unlistenLog) {
      this.unlistenLog = window.solus.onSetupLog((event) => this.applyLog(event))
      this.unlistenStatus = window.solus.onSetupStatus((event) => this.applyStatus(event))
    }
    return () => {
      this.listenerCount = Math.max(0, this.listenerCount - 1)
      if (this.listenerCount > 0) return
      this.unlistenLog?.()
      this.unlistenStatus?.()
      this.unlistenLog = null
      this.unlistenStatus = null
    }
  }

  syncServerName(name: string | null | undefined): void {
    if (this.serverNameDirty || this.serverNameDraft) return
    this.serverNameDraft = name?.trim() || 'Solus Server'
  }

  markServerNameDirty(): void {
    this.serverNameDirty = true
  }

  async saveServerName(): Promise<boolean> {
    const name = this.serverNameDraft.trim()
    if (!name) {
      toasts.error('Enter a server name.')
      return false
    }
    this.savingName = true
    try {
      const result = await window.solus.setServerName(name)
      this.serverNameDraft = result.name ?? name
      this.serverNameDirty = false
      await connectionsStore.refreshCapabilities()
      return true
    } catch (err) {
      toasts.error(`Couldn't save server name: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      this.savingName = false
    }
  }

  async installClaude(): Promise<void> {
    this.clearStep('install-claude')
    try {
      await window.solus.setupInstallAgentCli({ agent: 'claude' })
    } catch (err) {
      toasts.error(`Couldn't install Claude Code: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await connectionsStore.refreshCapabilities()
    }
  }

  async checkClaudeAuth(): Promise<void> {
    this.authCheck = await window.solus.setupCheckAgentAuth({ agent: 'claude' })
    await connectionsStore.refreshCapabilities()
  }

  async loadGithubRepos(opts: { force?: boolean } = {}): Promise<void> {
    if (this.reposLoading) return
    if (this.reposLoaded && !opts.force) return
    this.reposLoading = true
    try {
      const result = await window.solus.setupListGithubRepos()
      this.reposConnected = result.connected
      if (result.connected) {
        this.repos = result.repos
      } else {
        this.repos = []
      }
      this.reposLoaded = true
    } catch (err) {
      toasts.error(`Couldn't load repositories: ${err instanceof Error ? err.message : String(err)}`)
      this.repos = []
      this.reposLoaded = true
    } finally {
      this.reposLoading = false
    }
  }

  async cloneRepo(repo: SetupGithubRepo): Promise<void> {
    this.clearStep('clone')
    this.clonedProjectPath = null
    try {
      const result = await window.solus.setupCloneProject({
        cloneUrl: repo.cloneUrl,
        name: repo.name,
      })
      this.clonedProjectPath = result.path
      await projectsStore.loadProjects({ force: true })
    } catch (err) {
      toasts.error(`Couldn't clone repository: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await connectionsStore.refreshCapabilities()
    }
  }

  clearStep(step: SetupStreamStep): void {
    this.logs[step].splice(0, this.logs[step].length)
    delete this.statuses[step]
  }

  private applyLog(event: SetupLogEvent): void {
    const lines = this.logs[event.step]
    lines.push(event.line)
    if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT)
  }

  private applyStatus(event: SetupStatusEvent): void {
    this.statuses[event.step] = event.status
  }
}

export const serverSetupStore = new ServerSetupStore()
