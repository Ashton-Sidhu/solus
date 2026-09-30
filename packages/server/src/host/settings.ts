import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
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
import type { NotificationPreferencesPatch } from '@solus/contracts/notification-types'
import { z } from 'zod'
import { typeSafeKeyStatus } from '../typesafe/credentials'

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
 * The two flags `notifications` replaced. `soundEnabled` gated the sound and
 * the system alert together; `backgroundActivityToasts` gated toasts. Read only
 * when a stored host config predates the structured key, so a user who turned
 * sound off keeps it off.
 */
const legacyNotificationFlagsSchema = z.object({
  hostConfig: z.object({
    soundEnabled: z.boolean().optional(),
    backgroundActivityToasts: z.boolean().optional(),
    /** Presence is all that matters: a config that has the key is not legacy. */
    notifications: z.object({}).optional(),
  }).optional(),
})
type LegacyNotificationFlags = z.infer<typeof legacyNotificationFlagsSchema>

function notificationsFromLegacyFlags(legacy: LegacyNotificationFlags): NotificationPreferencesPatch | null {
  const flags = legacy.hostConfig
  if (!flags || flags.notifications !== undefined) return null
  if (flags.soundEnabled === undefined && flags.backgroundActivityToasts === undefined) return null
  const channels: NonNullable<NotificationPreferencesPatch['channels']> = {}
  if (flags.soundEnabled !== undefined) {
    channels.sound = flags.soundEnabled
    channels.system = flags.soundEnabled
  }
  if (flags.backgroundActivityToasts !== undefined) channels.toast = flags.backgroundActivityToasts
  return { channels }
}

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
  insightsOptInOrganizationIds: z.array(z.string().min(1)).optional(),
  projectsBaseDirectory: z.string().optional(),
  hostConfig: hostConfigPatchSchema.optional(),
  analytics: z.boolean().optional(),
  agentTaskLifecyclePolicy: z.enum(['none', 'moderate', 'autonomous']).optional(),
  textGenerationModel: legacyModelSelectionSchema.optional(),
  sourceControlWriterModel: legacyModelSelectionSchema.nullable().optional(),
  sourceControlWriting: legacySourceControlWritingSchema.optional(),
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
  /**
   * The config this host serves to its clients. Absent until a client seeds it:
   * the host cannot compute a platform-correct font default, so the first
   * client to connect writes one rather than the host guessing.
   */
  hostConfig?: HostConfig
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
}

let _settings: ServerSettings | null = null

export function getServerSettings(): ServerSettings {
  if (_settings) return _settings
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })

  if (existsSync(SETTINGS_FILE)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
      const parsed = persistedServerSettingsSchema.parse(raw)
      // `hostConfigPatchSchema` strips the flags `notifications` replaced, so
      // they are read from the same file through their own schema.
      const legacyNotifications = legacyNotificationFlagsSchema.safeParse(raw)
      _legacySettings = parsed
      _settings = {
        remoteAccess: parsed?.remoteAccess === true,
        metricsRetentionDays: normalizeMetricsRetentionDays(parsed?.metricsRetentionDays),
        trustLocalNetwork: parsed?.trustLocalNetwork === true,
        insightsOptInOrganizationIds: parsed?.insightsOptInOrganizationIds ?? [],
        projectsBaseDirectory: normalizeProjectsBaseDirectory(parsed?.projectsBaseDirectory),
        hostUser: parsed?.hostUser,
        hostConfig: loadHostConfig(
          parsed,
          legacyNotifications.success ? notificationsFromLegacyFlags(legacyNotifications.data) : null,
        ),
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
function loadHostConfig(
  parsed: PersistedSettings,
  legacyNotifications: NotificationPreferencesPatch | null,
): HostConfig | undefined {
  if (!parsed.hostConfig) return undefined
  const hostConfig = mergeHostConfig(seedHostConfig(parsed), parsed.hostConfig)
  if (!legacyNotifications) return hostConfig
  return mergeHostConfig(hostConfig, { notifications: legacyNotifications })
}

/** The legacy top-level block, kept only to seed host config on first write. */
let _legacySettings: PersistedSettings | undefined

export function getHostConfig(): HostConfigSnapshot {
  const settings = getServerSettings()
  return settings.hostConfig
    ? { config: settings.hostConfig, seeded: true, typeSafe: typeSafeKeyStatus() }
    : { config: seedHostConfig(_legacySettings), seeded: false, typeSafe: typeSafeKeyStatus() }
}

/**
 * Patches host config and persists it. The first call also seeds it, so the
 * snapshot it returns always reports `seeded: true`.
 *
 * The patch is already validated: untrusted input is parsed at the RPC
 * boundary, and every internal caller passes a typed literal.
 */
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

export function resolveTextGenerationModel(): TextGenerationModelSelection {
  const { config } = getHostConfig()
  return resolveAvailableModel(config.textGenerationModel)
}

export function resolveSourceControlWriterModel(): TextGenerationModelSelection {
  const { config } = getHostConfig()
  return resolveAvailableModel(config.sourceControlWriterModel, config.textGenerationModel)
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
