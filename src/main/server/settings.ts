import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { AGENT_BIN, DEFAULT_SOURCE_CONTROL_WRITING, MODEL_PROFILES } from '../../shared/types'
import type {
  AgentId,
  AgentTaskLifecyclePolicy,
  SourceControlWritingPreferences,
  TextGenerationModelSelection,
  TextGenerationSettings,
} from '../../shared/types'
import { findOnPath, getCliPath } from '../cli-env'
import { z } from 'zod'

const log = createLogger('main', 'server-settings')

const SOLUS_DIR = solusDir()
const SETTINGS_FILE = join(SOLUS_DIR, 'server-settings.json')

const modelSelectionSchema = z.object({
  provider: z.enum(['codex', 'claude-code']),
  model: z.string(),
}).strict()
const sourceControlWritingSchema = z.object({
  mode: z.enum(['repo_conventions', 'conventional_commits', 'custom']).optional(),
  customInstructions: z.string().optional(),
  followPullRequestTemplate: z.boolean().optional(),
}).strict()
const persistedServerSettingsSchema = z.object({
  remoteAccess: z.boolean().optional(),
  agentTaskLifecyclePolicy: z.enum(['none', 'moderate', 'autonomous']).optional(),
  analytics: z.boolean().optional(),
  name: z.string().optional(),
  projectsBaseDirectory: z.string().optional(),
  textGenerationModel: modelSelectionSchema.optional(),
  sourceControlWriterModel: modelSelectionSchema.nullable().optional(),
  sourceControlWriting: sourceControlWritingSchema.optional(),
}).strip()

export interface ServerSettings {
  remoteAccess: boolean
  agentTaskLifecyclePolicy: AgentTaskLifecyclePolicy
  /** Absent means analytics remain enabled for installations created before this setting. */
  analytics?: boolean
  name?: string
  /**
   * Where projects live on this host: what "Open project" lists, and where its
   * primary action puts a clone. Empty means the home folder.
   */
  projectsBaseDirectory?: string
  textGenerationModel: TextGenerationModelSelection
  sourceControlWriterModel: TextGenerationModelSelection | null
  sourceControlWriting: SourceControlWritingPreferences
}

const DEFAULT_TEXT_GENERATION_MODELS = {
  codex: 'gpt-5.6-luna',
  'claude-code': 'claude-haiku-4-5-20251001',
} satisfies Record<AgentId, string>

const DEFAULT_SETTINGS: ServerSettings = {
  remoteAccess: true,
  agentTaskLifecyclePolicy: 'moderate',
  textGenerationModel: { provider: 'codex', model: DEFAULT_TEXT_GENERATION_MODELS.codex },
  sourceControlWriterModel: null,
  sourceControlWriting: DEFAULT_SOURCE_CONTROL_WRITING,
}

let _settings: ServerSettings | null = null

export function getServerSettings(): ServerSettings {
  if (_settings) return _settings
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })

  if (existsSync(SETTINGS_FILE)) {
    try {
      const parsed = persistedServerSettingsSchema.parse(JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')))
      _settings = {
        remoteAccess: parsed?.remoteAccess === true,
        agentTaskLifecyclePolicy: normalizeAgentTaskLifecyclePolicy(parsed?.agentTaskLifecyclePolicy),
        analytics: parsed.analytics,
        name: normalizeServerName(parsed?.name),
        projectsBaseDirectory: normalizeProjectsBaseDirectory(parsed?.projectsBaseDirectory),
        textGenerationModel: normalizeModelSelection(parsed?.textGenerationModel)
          ?? DEFAULT_SETTINGS.textGenerationModel,
        sourceControlWriterModel: parsed?.sourceControlWriterModel === null
          ? null
          : normalizeModelSelection(parsed?.sourceControlWriterModel),
        sourceControlWriting: normalizeSourceControlWriting(parsed?.sourceControlWriting),
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

export function setTextGenerationSettings(
  patch: Partial<TextGenerationSettings>,
): ServerSettings {
  const current = getServerSettings()
  _settings = {
    ...current,
    textGenerationModel: patch.textGenerationModel
      ? requireModelSelection(patch.textGenerationModel)
      : current.textGenerationModel,
    sourceControlWriterModel: patch.sourceControlWriterModel === undefined
      ? current.sourceControlWriterModel
      : patch.sourceControlWriterModel === null
        ? null
        : requireModelSelection(patch.sourceControlWriterModel),
    sourceControlWriting: patch.sourceControlWriting
      ? normalizeSourceControlWriting(patch.sourceControlWriting)
      : current.sourceControlWriting,
  }
  persistSettings(_settings)
  log.info('text_generation_settings_changed', {
    textGenerationProvider: _settings.textGenerationModel.provider,
    sourceControlWriterProvider: _settings.sourceControlWriterModel?.provider ?? null,
  })
  return _settings
}

export function resolveTextGenerationModel(): TextGenerationModelSelection {
  return resolveAvailableModel(getServerSettings().textGenerationModel)
}

export function resolveSourceControlWriterModel(): TextGenerationModelSelection {
  const settings = getServerSettings()
  return settings.sourceControlWriterModel
    ? resolveAvailableModel(settings.sourceControlWriterModel, settings.textGenerationModel)
    : resolveAvailableModel(settings.textGenerationModel)
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

function normalizeAgentTaskLifecyclePolicy(value: AgentTaskLifecyclePolicy | undefined): AgentTaskLifecyclePolicy {
  return value === 'none' || value === 'autonomous' ? value : 'moderate'
}

function normalizeModelSelection(value: TextGenerationModelSelection | null | undefined): TextGenerationModelSelection | null {
  if (!value?.model.trim()) return null
  return { provider: value.provider, model: value.model.trim().slice(0, 200) }
}

function normalizeSourceControlWriting(value: Partial<SourceControlWritingPreferences> | undefined): SourceControlWritingPreferences {
  if (!value) return { ...DEFAULT_SOURCE_CONTROL_WRITING }
  return {
    mode: value.mode ?? DEFAULT_SOURCE_CONTROL_WRITING.mode,
    customInstructions: value.customInstructions?.trim().slice(0, 8_000) ?? '',
    followPullRequestTemplate: value.followPullRequestTemplate !== false,
  }
}

function requireModelSelection(value: TextGenerationModelSelection): TextGenerationModelSelection {
  const normalized = normalizeModelSelection(value)
  if (!normalized) throw new Error('Invalid text-generation model selection.')
  return normalized
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
  return { ...DEFAULT_SETTINGS.textGenerationModel }
}

function resolveAvailableModel(
  selection: TextGenerationModelSelection,
  fallback?: TextGenerationModelSelection,
): TextGenerationModelSelection {
  if (isAvailable(selection)) return selection
  if (fallback && isAvailable(fallback)) return fallback
  return automaticTextGenerationModel()
}
