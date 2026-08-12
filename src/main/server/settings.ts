import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import type { AgentTaskLifecyclePolicy } from '../../shared/types'

const log = createLogger('main', 'server-settings')

const SOLUS_DIR = solusDir()
const SETTINGS_FILE = join(SOLUS_DIR, 'server-settings.json')

export interface ServerSettings {
  remoteAccess: boolean
  metricsRetentionDays: number
  agentTaskLifecyclePolicy: AgentTaskLifecyclePolicy
  /** Absent means analytics remain enabled for installations created before this setting. */
  analytics?: boolean
  name?: string
  /**
   * Where projects live on this host: what "Open project" lists, and where its
   * primary action puts a clone. Empty means the home folder.
   */
  projectsBaseDirectory?: string
}

const DEFAULT_SETTINGS: ServerSettings = {
  remoteAccess: true,
  metricsRetentionDays: 30,
  agentTaskLifecyclePolicy: 'moderate',
}

let _settings: ServerSettings | null = null

export function getServerSettings(): ServerSettings {
  if (_settings) return _settings
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })

  if (existsSync(SETTINGS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
      _settings = {
        remoteAccess: parsed?.remoteAccess === true,
        metricsRetentionDays: normalizeMetricsRetentionDays(parsed?.metricsRetentionDays),
        agentTaskLifecyclePolicy: normalizeAgentTaskLifecyclePolicy(parsed?.agentTaskLifecyclePolicy),
        analytics: typeof parsed?.analytics === 'boolean' ? parsed.analytics : undefined,
        name: normalizeServerName(parsed?.name),
        projectsBaseDirectory: normalizeProjectsBaseDirectory(parsed?.projectsBaseDirectory),
      }
      return _settings
    } catch (err) {
      log.warn('server_settings_load_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  _settings = { ...DEFAULT_SETTINGS }
  return _settings
}

export function setRemoteAccess(remoteAccess: boolean): ServerSettings {
  _settings = { ...getServerSettings(), remoteAccess }
  persistSettings(_settings)
  return _settings
}

export function setMetricsRetentionDays(metricsRetentionDays: number): ServerSettings {
  _settings = { ...getServerSettings(), metricsRetentionDays: normalizeMetricsRetentionDays(metricsRetentionDays) }
  persistSettings(_settings)
  return _settings
}

export function setAnalyticsConsent(analytics: boolean): ServerSettings {
  _settings = { ...getServerSettings(), analytics }
  persistSettings(_settings)
  log.info('analytics_consent_changed', { analytics })
  return _settings
}

export function setAgentTaskLifecyclePolicy(
  agentTaskLifecyclePolicy: AgentTaskLifecyclePolicy,
): ServerSettings {
  _settings = { ...getServerSettings(), agentTaskLifecyclePolicy }
  persistSettings(_settings)
  log.info('agent_task_lifecycle_policy_changed', { agentTaskLifecyclePolicy })
  return _settings
}

export function setServerName(name: string): ServerSettings {
  const normalized = normalizeServerName(name)
  if (!normalized) throw new Error('Server name cannot be empty.')
  _settings = { ...getServerSettings(), name: normalized }
  persistSettings(_settings)
  return _settings
}

/** Empty clears the setting, so the picker falls back to the home folder. */
export function setProjectsBaseDirectory(path: string): ServerSettings {
  _settings = { ...getServerSettings(), projectsBaseDirectory: normalizeProjectsBaseDirectory(path) }
  persistSettings(_settings)
  return _settings
}

function persistSettings(next: ServerSettings): void {
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
}

function normalizeServerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, 80) : undefined
}

function normalizeProjectsBaseDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 1024) : undefined
}

function normalizeMetricsRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return DEFAULT_SETTINGS.metricsRetentionDays
  return value
}

function normalizeAgentTaskLifecyclePolicy(value: unknown): AgentTaskLifecyclePolicy {
  return value === 'none' || value === 'autonomous' ? value : 'moderate'
}
