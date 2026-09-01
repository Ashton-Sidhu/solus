import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { AGENT_BIN, MODEL_PROFILES } from '@solus/contracts/types'
import type { TextGenerationModelSelection } from '@solus/contracts/types'
import { findOnPath, getCliPath } from '../cli-env'
import {
  DEFAULT_HOST_CONFIG,
  DEFAULT_TEXT_GENERATION_MODELS,
  hostConfigPatchSchema,
  mergeHostConfig,
} from '@solus/contracts/host-config'
import type { HostConfig, HostConfigPatch, HostConfigSnapshot } from '@solus/contracts/host-config'
import { z } from 'zod'

const log = createLogger('main', 'server-settings')

const SOLUS_DIR = solusDir()
const SETTINGS_FILE = join(SOLUS_DIR, 'server-settings.json')

const legacyModelSelectionSchema = z.object({
  provider: z.enum(['codex', 'claude-code']),
  model: z.string(),
}).strict()
const legacySourceControlWritingSchema = z.object({
  mode: z.enum(['repo_conventions', 'conventional_commits', 'custom']).optional(),
  customInstructions: z.string().optional(),
  followPullRequestTemplate: z.boolean().optional(),
}).strict()
/**
 * The legacy keys are the pre-host-config shape of this file. They are still
 * read, because an installation that set analytics consent or a text-generation
 * model before the move must not silently lose it. They seed host config on the
 * first load and are no longer written.
 */
const persistedServerSettingsSchema = z.object({
  remoteAccess: z.boolean().optional(),
  metricsRetentionDays: z.number().optional(),
  trustLocalNetwork: z.boolean().optional(),
  name: z.string().optional(),
  projectsBaseDirectory: z.string().optional(),
  hostConfig: hostConfigPatchSchema.optional(),
  analytics: z.boolean().optional(),
  agentTaskLifecyclePolicy: z.enum(['none', 'moderate', 'autonomous']).optional(),
  textGenerationModel: legacyModelSelectionSchema.optional(),
  backupTextGenerationModel: legacyModelSelectionSchema.optional(),
  sourceControlWriterModel: legacyModelSelectionSchema.nullable().optional(),
  sourceControlWriting: legacySourceControlWritingSchema.optional(),
}).strip()

/**
 * What belongs to the machine rather than to the workspace: how it is reached,
 * what it is called, how much history it keeps. Everything a user or an
 * operator *configures* now lives in `hostConfig`, which has one schema, one
 * validation path, and one change event.
 */
export interface ServerSettings {
  remoteAccess: boolean
  metricsRetentionDays: number
  /** Requesters from private-range (RFC1918) addresses skip pairing. Off by
   *  default: a shared network is not an identity unless the owner says so. */
  trustLocalNetwork: boolean
  name?: string
  /**
   * Where projects live on this host: what "Open project" lists, and where its
   * primary action puts a clone. Empty means the home folder.
   */
  projectsBaseDirectory?: string
  /**
   * The config this host serves to its clients. Absent until a client seeds it:
   * the host cannot compute a platform-correct font default, so the first
   * client to connect writes one rather than the host guessing.
   */
  hostConfig?: HostConfig
}

const DEFAULT_SETTINGS: ServerSettings = {
  remoteAccess: true,
  metricsRetentionDays: 30,
  trustLocalNetwork: false,
}

let _settings: ServerSettings | null = null

export function getServerSettings(): ServerSettings {
  if (_settings) return _settings
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })

  if (existsSync(SETTINGS_FILE)) {
    try {
      const parsed = persistedServerSettingsSchema.parse(JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')))
      _legacySettings = parsed
      _settings = {
        remoteAccess: parsed?.remoteAccess === true,
        metricsRetentionDays: normalizeMetricsRetentionDays(parsed?.metricsRetentionDays),
        trustLocalNetwork: parsed?.trustLocalNetwork === true,
        name: normalizeServerName(parsed?.name),
        projectsBaseDirectory: normalizeProjectsBaseDirectory(parsed?.projectsBaseDirectory),
        hostConfig: loadHostConfig(parsed),
      }
      return _settings
    } catch (err) {
      log.warn('server_settings_load_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  _settings = { ...DEFAULT_SETTINGS }
  return _settings
}

type PersistedSettings = z.infer<typeof persistedServerSettingsSchema>

/**
 * The starting point for a host that has never been written to, built from the
 * keys this file used to hold at top level.
 *
 * Every one of these is a choice someone already made: an analytics opt-out or
 * a text-generation model. Falling back to the plain defaults would silently
 * reverse those choices.
 */
function seedHostConfig(legacy: PersistedSettings | undefined): HostConfig {
  const patch: HostConfigPatch = { analyticsEnabled: legacy?.analytics !== false }
  if (legacy?.agentTaskLifecyclePolicy) patch.agentTaskLifecyclePolicy = legacy.agentTaskLifecyclePolicy
  if (legacy?.textGenerationModel) patch.textGenerationModel = legacy.textGenerationModel
  if (legacy?.backupTextGenerationModel) {
    patch.backupTextGenerationModel = legacy.backupTextGenerationModel
  }
  // Null is a real choice here — "no separate source-control writer" — so it is
  // carried forward, unlike the keys above where absence means "never set".
  if (legacy?.sourceControlWriterModel !== undefined) {
    patch.sourceControlWriterModel = legacy.sourceControlWriterModel
  }
  if (legacy?.sourceControlWriting) patch.sourceControlWriting = legacy.sourceControlWriting
  return mergeHostConfig(DEFAULT_HOST_CONFIG, patch)
}

/** Undefined means no client has seeded this host yet — distinct from a config
 *  that exists and happens to match the defaults. */
function loadHostConfig(parsed: PersistedSettings): HostConfig | undefined {
  if (!parsed.hostConfig) return undefined
  return mergeHostConfig(seedHostConfig(parsed), parsed.hostConfig)
}

/** The legacy top-level block, kept only to seed host config on first write. */
let _legacySettings: PersistedSettings | undefined

export function getHostConfig(): HostConfigSnapshot {
  const settings = getServerSettings()
  return settings.hostConfig
    ? { config: settings.hostConfig, seeded: true }
    : { config: seedHostConfig(_legacySettings), seeded: false }
}

/**
 * Patches host config and persists it. The first call also seeds it, so the
 * snapshot it returns always reports `seeded: true`.
 *
 * The patch is already validated: untrusted input is parsed at the RPC
 * boundary, and every internal caller passes a typed literal.
 */
export function setHostConfig(patch: HostConfigPatch): HostConfigSnapshot {
  const hostConfig = mergeHostConfig(getHostConfig().config, patch)
  _settings = { ...getServerSettings(), hostConfig }
  persistSettings(_settings)
  // The values are the user's; only which keys moved is logged.
  log.info('host_config_changed', { keys: Object.keys(patch).sort() })
  return { config: hostConfig, seeded: true }
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

export function resolveTextGenerationModel(): TextGenerationModelSelection {
  const { config } = getHostConfig()
  return resolveAvailableModel(config.textGenerationModel, config.backupTextGenerationModel)
}

export function resolveSourceControlWriterModel(): TextGenerationModelSelection {
  const { config } = getHostConfig()
  return resolveAvailableModel(
    config.sourceControlWriterModel,
    config.textGenerationModel,
    config.backupTextGenerationModel,
  )
}

function persistSettings(next: ServerSettings): void {
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
}

function normalizeServerName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, 80) : undefined
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

function automaticTextGenerationModel(): TextGenerationModelSelection {
  for (const provider of ['codex', 'claude-code'] as const) {
    const selection = { provider, model: DEFAULT_TEXT_GENERATION_MODELS[provider] }
    if (isAvailable(selection)) return selection
  }
  return { ...DEFAULT_HOST_CONFIG.textGenerationModel }
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
