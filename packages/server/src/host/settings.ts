import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { AGENT_BIN, MODEL_PROFILES } from '@solus/contracts/types'
import type { SourceControlWritingPreferences, TextGenerationModelSelection } from '@solus/contracts/types'
import { findOnPath, getCliPath } from '../cli-env'
import {
  DEFAULT_HOST_CONFIG,
  HOST_CONFIG_FIELDS,
  isHostConfigKey,
  mergeHostConfig,
} from '@solus/contracts/host-config'
import type { HostConfig, HostConfigPatch, HostConfigSnapshot } from '@solus/contracts/host-config'
import { z } from 'zod'
import { DEFAULT_EXECUTION_PREFERENCES, DEFAULT_TEXT_GENERATION_MODELS, type ExecutionPreferences } from '@solus/contracts/settings'
import { typeSafeKeyStatus } from '../typesafe/credentials'
import { hostCategory } from './host-category'

const log = createLogger('main', 'server-settings')

const SOLUS_DIR = solusDir()
const SETTINGS_FILE = join(SOLUS_DIR, 'server-settings.json')

const persistedServerSettingsSchema = z.object({
  remoteAccess: z.boolean().optional(),
  metricsRetentionDays: z.number().optional(),
  trustLocalNetwork: z.boolean().optional(),
  insightsOptInOrganizationIds: z.array(z.string().min(1)).optional(),
  projectsBaseDirectory: z.string().optional(),
  /** Read key by key in `storedHostConfig`, so one bad key does not cost the rest. */
  hostConfig: z.looseObject({}).optional(),
  hostUser: z.object({
    localId: z.string().min(1),
    account: z.object({ accountId: z.string().min(1), displayName: z.string().optional(), email: z.string().optional() }).optional(),
    adoptedAt: z.number().optional(),
  }).optional(),
}).strip()

/**
 * What belongs to the machine rather than to the workspace: how it is reached
 * and how much history it keeps. Everything a user or an
 * operator *configures* now lives in `hostConfig`, which has one schema, one
 * validation path, and one change event.
 */
export interface ServerSettings {
  remoteAccess: boolean
  metricsRetentionDays: number
  /**
   * Organizations the person at this host opted its work into while that
   * organization's **Sync all Insights** is off (organization-scope §6.1). An
   * organization whose policy is on needs no entry: its sessions send Insights
   * whatever this says.
   */
  insightsOptInOrganizationIds?: string[]
  /** Requesters from private-range (RFC1918) addresses skip pairing. Off by
   *  default: a shared network is not an identity unless the owner says so. */
  trustLocalNetwork: boolean
  /**
   * Where projects live on this host: what "Open project" lists, and where its
   * primary action puts a clone. Empty means the home folder.
   */
  projectsBaseDirectory?: string
  /** The config this host serves to the clients that administer it. */
  hostConfig: HostConfig
  /** The host's own user (plans/012 §1). Minted once by `hostUserSettings`. */
  hostUser?: HostUserSettings
}

/**
 * The host's own user: the `local` id minted once for its owner, and the account
 * the owner's rows moved to when the host was linked (U4, U5). `adoptedAt` is when
 * the rows written before users had ids were moved to this user.
 */
export interface HostUserSettings {
  localId: string
  account?: { accountId: string; displayName?: string; email?: string }
  adoptedAt?: number
}

const DEFAULT_SETTINGS: ServerSettings = {
  remoteAccess: true,
  metricsRetentionDays: 30,
  trustLocalNetwork: false,
  hostConfig: DEFAULT_HOST_CONFIG,
}

let _settings: ServerSettings | null = null

export function getServerSettings(): ServerSettings {
  if (_settings) return _settings
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })

  if (existsSync(SETTINGS_FILE)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
      const parsed = persistedServerSettingsSchema.parse(raw)
      _settings = {
        remoteAccess: parsed?.remoteAccess === true,
        metricsRetentionDays: normalizeMetricsRetentionDays(parsed?.metricsRetentionDays),
        trustLocalNetwork: parsed?.trustLocalNetwork === true,
        insightsOptInOrganizationIds: parsed?.insightsOptInOrganizationIds ?? [],
        projectsBaseDirectory: normalizeProjectsBaseDirectory(parsed?.projectsBaseDirectory),
        hostUser: parsed?.hostUser,
        hostConfig: storedHostConfig(parsed.hostConfig),
      }
      return _settings
    } catch (err) {
      log.warn('server_settings_load_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  _settings = { ...DEFAULT_SETTINGS }
  return _settings
}

/**
 * The stored config, read one key at a time. This file is local to the host, so
 * a key that no longer validates falls back to its default and a key this host
 * does not know is dropped; both leave the rest of the config as it was. The
 * next write stores the healed config.
 */
function storedHostConfig(stored: z.infer<typeof persistedServerSettingsSchema>['hostConfig']): HostConfig {
  if (!stored) return DEFAULT_HOST_CONFIG
  const patch: HostConfigPatch = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(stored)) {
    const parsed = isHostConfigKey(key) ? HOST_CONFIG_FIELDS[key].patch.safeParse(value) : null
    if (parsed?.success) Object.assign(patch, { [key]: parsed.data })
    else dropped.push(key)
  }
  // Only key names are logged; a value may carry collector credentials.
  if (dropped.length) log.warn('host_config_keys_dropped', { keys: dropped.sort() })
  return mergeHostConfig(DEFAULT_HOST_CONFIG, patch)
}

export function getHostConfig(): HostConfigSnapshot {
  const stored = getServerSettings().hostConfig
  const config = hostCategory() === 'managed' && stored.continueSessionsAfterHostRestart
    ? { ...stored, continueSessionsAfterHostRestart: false }
    : stored
  return { config, typeSafe: typeSafeKeyStatus() }
}

/** The organizations this machine's work is opted into for Insights while their policy is off (§6.1). */
export function getInsightsOptIn(): string[] {
  return [...(getServerSettings().insightsOptInOrganizationIds ?? [])]
}

export function setInsightsOptIn(organizationId: string, enabled: boolean): string[] {
  const current = new Set(getInsightsOptIn())
  if (enabled) current.add(organizationId)
  else current.delete(organizationId)
  const next = [...current].sort()
  _settings = { ...getServerSettings(), insightsOptInOrganizationIds: next }
  persistSettings(_settings)
  log.info('insights_opt_in_changed', { organizationId, enabled })
  return next
}

/** The host's user; the first call mints its `local` id and stores it. */
export function hostUserSettings(): HostUserSettings {
  const stored = getServerSettings().hostUser
  if (stored) return stored
  const hostUser: HostUserSettings = { localId: randomUUID() }
  _settings = { ...getServerSettings(), hostUser }
  persistSettings(_settings)
  log.info('host_local_user_minted', { localId: hostUser.localId })
  return hostUser
}

export function setHostUserSettings(hostUser: HostUserSettings): void {
  _settings = { ...getServerSettings(), hostUser }
  persistSettings(_settings)
}

export function setHostConfig(patch: HostConfigPatch): HostConfigSnapshot {
  const hostConfig = mergeHostConfig(getHostConfig().config, patch)
  if (hostCategory() === 'managed') hostConfig.continueSessionsAfterHostRestart = false
  _settings = { ...getServerSettings(), hostConfig }
  persistSettings(_settings)
  // The values are the user's; only which keys moved is logged.
  log.info('host_config_changed', { keys: Object.keys(patch).sort() })
  return getHostConfig()
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

export function setTrustLocalNetwork(trustLocalNetwork: boolean): ServerSettings {
  _settings = { ...getServerSettings(), trustLocalNetwork }
  persistSettings(_settings)
  log.info('trust_local_network_changed', { trustLocalNetwork })
  return _settings
}

/** Empty clears the setting, so the picker falls back to the home folder. */
export function setProjectsBaseDirectory(path: string): ServerSettings {
  _settings = { ...getServerSettings(), projectsBaseDirectory: normalizeProjectsBaseDirectory(path) }
  persistSettings(_settings)
  return _settings
}

/**
 * The model for writing done for a person — titles, worktree names — from their
 * own preference (plans/018 §3.1), else the installed fallback. The host's config
 * is not consulted: it is not the person's.
 */
export function resolveTextGenerationModel(preferences: Pick<ExecutionPreferences, 'textGenerationModel'> | undefined): TextGenerationModelSelection {
  return resolveAvailableModel(preferences?.textGenerationModel ?? DEFAULT_EXECUTION_PREFERENCES.textGenerationModel)
}

/** The person's commit and pull-request writing choices; the built-in ones when they sent none. */
export function sourceControlWritingFor(preferences: Pick<ExecutionPreferences, 'sourceControlWriting'> | undefined): SourceControlWritingPreferences {
  return preferences?.sourceControlWriting ?? DEFAULT_EXECUTION_PREFERENCES.sourceControlWriting
}

/** The person's commit and pull-request writer; null falls back to their own text-generation model. */
export function resolveSourceControlWriterModel(preferences: Pick<ExecutionPreferences, 'textGenerationModel' | 'sourceControlWriterModel'> | undefined): TextGenerationModelSelection {
  return resolveAvailableModel(
    preferences?.sourceControlWriterModel ?? null,
    preferences?.textGenerationModel ?? DEFAULT_EXECUTION_PREFERENCES.textGenerationModel,
  )
}

function persistSettings(next: ServerSettings): void {
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
}

function normalizeProjectsBaseDirectory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 1024) : undefined
}

function normalizeMetricsRetentionDays(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return DEFAULT_SETTINGS.metricsRetentionDays
  return value
}

function isAvailable(selection: TextGenerationModelSelection): boolean {
  return !!findOnPath(AGENT_BIN[selection.provider], getCliPath())
    && !!MODEL_PROFILES[selection.provider]?.[selection.model]
}

/**
 * The rule when nothing configured is installed: each backend has one cheap
 * model for background writing, and Codex wins when both are on the host. There
 * is no second user-chosen model to consult — the host picks what it can run.
 */
function automaticTextGenerationModel(): TextGenerationModelSelection {
  for (const provider of ['codex', 'claude-code'] as const) {
    const selection = { provider, model: DEFAULT_TEXT_GENERATION_MODELS[provider] }
    if (isAvailable(selection)) return selection
  }
  return { ...DEFAULT_EXECUTION_PREFERENCES.textGenerationModel }
}

/** Candidates run in preference order; an absent one is simply skipped. */
function resolveAvailableModel(
  ...candidates: (TextGenerationModelSelection | null)[]
): TextGenerationModelSelection {
  for (const candidate of candidates) {
    if (candidate && isAvailable(candidate)) return candidate
  }
  return automaticTextGenerationModel()
}
