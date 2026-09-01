// ─── Host config ───
//
// The durable configuration tier: what a host owns and serves to every client
// that connects to it, so a user's choices follow them between desktop, web,
// and mobile.
//
// The other tier is device config, which stays in the client's `localStorage`
// and never crosses this boundary — zoom, keybindings, pane widths, panel
// collapse state, the sidebar filter, and the onboarding flag. A device
// binding is not portable (a desktop global shortcut cannot fire on web) and a
// pane width describes one screen, so syncing either would ship a value that
// provably does not apply. See `docs/plans/config-overhaul.md`.
//
// Operator settings — remote access, LAN trust, otel export, the text
// generation models — are host state too, but they are not part of this
// surface. They keep their own dedicated setters because flipping them has
// security consequences that a generic patch must not be able to reach.

import { z } from 'zod'
import type {
  AgentId,
  AgentTaskLifecyclePolicy,
  AppCodeFontFamily,
  AppFontFamily,
  EditorId,
  OtelSettings,
  ReasoningEffort,
  SourceControlWritingPreferences,
  TerminalAppId,
  TextGenerationModelSelection,
} from './types'
import { DEFAULT_SOURCE_CONTROL_WRITING, EDITOR_IDS, TERMINAL_APP_IDS } from './types'

export type ThemeMode = 'system' | 'light' | 'dark'
export type RateLimitBehavior = 'ask' | 'queue' | 'continue' | 'stop'
export type DocumentFontFamily = 'solus' | AppFontFamily

export const TAB_GROUP_MODES = ['flat', 'status', 'unread'] as const
export type TabGroupMode = (typeof TAB_GROUP_MODES)[number]

/** Days a done task stays on the sidebar's Completed shelf. Lives here because
 *  it is the default of a host-config key; `lib/completed-task-retention`
 *  re-exports it so renderer call sites keep one import. */
export const DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS = 2

export interface HostConfig {
  themeMode: ThemeMode
  soundEnabled: boolean
  voiceModeEnabled: boolean
  autoSendVoiceTranscripts: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  fallbackTerminal: TerminalAppId | null
  activeAgent: AgentId
  /** Per-agent model for new sessions; a missing entry means that agent's built-in default. */
  defaultModels: Record<string, string>
  /** Review companion backend; null means use `activeAgent`. */
  reviewAgent: AgentId | null
  reviewModel: string | null
  reviewReasoning: ReasoningEffort | null
  stackedPrsEnabled: boolean
  generatePrGuidesOnOpen: boolean
  /**
   * Keyed by project path. Host config rather than device config because the
   * key is a path on this host — the same map on another machine would name
   * directories that do not exist there.
   */
  reviewWarmingByProject: Record<string, boolean>
  rateLimitBehavior: RateLimitBehavior
  autoRenameSessions: boolean
  showDiffSummaryAfterTurn: boolean
  fontFamily: AppFontFamily
  fontSize: number
  codeFontFamily: AppCodeFontFamily
  codeFontSize: number
  documentFontFamily: DocumentFontFamily
  documentFontSize: number
  /** App-wide instructions appended to every agent system prompt, on every turn. */
  extraInstructions: string
  /** Extra instructions keyed by resolved model id, appended when that model runs. */
  modelInstructions: Record<string, string>
  analyticsEnabled: boolean
  tabGroupMode: TabGroupMode
  sidebarCompletedRetentionDays: number

  // ─── Operator settings ───
  //
  // Host-machine choices rather than personal ones, folded in here so there is
  // one config surface, one validation path, and one change event. Before this
  // they had dedicated setters that broadcast nothing, so a change made on
  // desktop left every other connected client showing stale values forever.
  //
  // All of them are closed to agents, and `otel` is never sent to one at all —
  // its `headers` field carries collector credentials.

  agentTaskLifecyclePolicy: AgentTaskLifecyclePolicy
  /** Where this host sends its own telemetry. */
  otel: OtelSettings
  textGenerationModel: TextGenerationModelSelection
  backupTextGenerationModel: TextGenerationModelSelection
  /** Null means fall back to `textGenerationModel`. */
  sourceControlWriterModel: TextGenerationModelSelection | null
  sourceControlWriting: SourceControlWritingPreferences
}

const APP_FONT_FAMILIES = ['inter', 'dm-sans', 'system', 'geist', 'lora', 'sf-pro-text', 'sf-mono'] as const
const APP_CODE_FONT_FAMILIES = ['sf-mono', 'geist-mono', 'fira-code', 'cascadia-code', 'jetbrains-mono', 'system-mono'] as const
const AGENT_IDS = ['claude-code', 'codex', 'opencode'] as const satisfies readonly AgentId[]
const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const satisfies readonly ReasoningEffort[]

export const DEFAULT_OTEL_SETTINGS: OtelSettings = {
  enabled: false,
  endpoint: '',
  headers: '',
  exportLogs: true,
  exportMetrics: true,
  exportTraces: true,
}

export const DEFAULT_TEXT_GENERATION_MODELS = {
  codex: 'gpt-5.6-luna',
  'claude-code': 'claude-haiku-4-5-20251001',
} as const

/**
 * The nested keys arrive as partials — the Telemetry panel toggles one switch
 * at a time — so these only check shape. Normalization happens in
 * `mergeHostConfig`, after the patch is merged onto the current value, because
 * normalizing a partial would reset the fields it does not carry.
 */
const otelPatchSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().optional(),
  headers: z.string().optional(),
  exportLogs: z.boolean().optional(),
  exportMetrics: z.boolean().optional(),
  exportTraces: z.boolean().optional(),
}).strict()

const sourceControlWritingPatchSchema = z.object({
  mode: z.enum(['repo_conventions', 'conventional_commits', 'custom']).optional(),
  customInstructions: z.string().optional(),
  followPullRequestTemplate: z.boolean().optional(),
}).strict()

/** A model selection is always sent whole, so it normalizes in place. */
const modelSelectionSchema = z.object({
  provider: z.enum(['codex', 'claude-code']),
  model: z.string(),
}).strict().transform((selection) => ({
  provider: selection.provider,
  model: selection.model.trim().slice(0, 200),
}))

/** Enabling with no endpoint would be a switch that reports "on" while
 *  exporting nowhere, so the endpoint is part of being enabled. The endpoint is
 *  stripped of the trailing slash that would otherwise produce `host//v1/traces`. */
export function normalizeOtelSettings(otel: Partial<OtelSettings> | undefined): OtelSettings {
  if (!otel) return { ...DEFAULT_OTEL_SETTINGS }
  const endpoint = (otel.endpoint ?? '').trim().replace(/\/+$/, '')
  return {
    enabled: otel.enabled === true && endpoint.length > 0,
    endpoint,
    headers: (otel.headers ?? '').trim(),
    exportLogs: otel.exportLogs !== false,
    exportMetrics: otel.exportMetrics !== false,
    exportTraces: otel.exportTraces !== false,
  }
}

function normalizeSourceControlWriting(
  value: Partial<SourceControlWritingPreferences> | undefined,
): SourceControlWritingPreferences {
  if (!value) return { ...DEFAULT_SOURCE_CONTROL_WRITING }
  return {
    mode: value.mode ?? DEFAULT_SOURCE_CONTROL_WRITING.mode,
    customInstructions: value.customInstructions?.trim().slice(0, 8_000) ?? '',
    followPullRequestTemplate: value.followPullRequestTemplate !== false,
  }
}

/**
 * Every field is optional and every field self-heals with `.catch`, so a
 * hand-edited or partially-written config never costs a user their whole
 * settings blob — only the one key that is wrong falls back to its default.
 */
export const hostConfigPatchSchema = z.object({
  themeMode: z.enum(['system', 'light', 'dark']).catch('dark'),
  soundEnabled: z.boolean().catch(true),
  voiceModeEnabled: z.boolean().catch(false),
  autoSendVoiceTranscripts: z.boolean().catch(false),
  vadSilenceMs: z.number().transform((value) => Math.max(1000, Math.min(8000, value))).catch(1500),
  defaultEditor: z.enum(EDITOR_IDS).nullable().catch(null),
  fallbackTerminal: z.enum(TERMINAL_APP_IDS).nullable().catch(null),
  activeAgent: z.enum(AGENT_IDS).catch('claude-code'),
  defaultModels: z.record(z.string(), z.string()).catch({}),
  reviewAgent: z.enum(AGENT_IDS).nullable().catch(null),
  reviewModel: z.string().nullable().catch(null),
  reviewReasoning: z.enum(REASONING_EFFORTS).nullable().catch(null),
  stackedPrsEnabled: z.boolean().catch(false),
  generatePrGuidesOnOpen: z.boolean().catch(false),
  reviewWarmingByProject: z.record(z.string(), z.boolean()).catch({}),
  rateLimitBehavior: z.enum(['ask', 'queue', 'continue', 'stop']).catch('ask'),
  autoRenameSessions: z.boolean().catch(true),
  showDiffSummaryAfterTurn: z.boolean().catch(true),
  fontFamily: z.enum(APP_FONT_FAMILIES).catch('inter'),
  fontSize: z.number().min(8).max(32).catch(13),
  codeFontFamily: z.enum(APP_CODE_FONT_FAMILIES).catch('jetbrains-mono'),
  codeFontSize: z.number().min(8).max(32).catch(12),
  documentFontFamily: z.enum(['solus', ...APP_FONT_FAMILIES]).catch('solus'),
  documentFontSize: z.number().min(12).max(40).catch(16),
  // Bounded because it is concatenated into every system prompt: an accidental
  // paste of a whole file would silently eat the context window of every turn.
  extraInstructions: z.string().max(20_000).catch(''),
  modelInstructions: z.record(z.string(), z.string().max(20_000)).catch({}),
  analyticsEnabled: z.boolean().catch(true),
  tabGroupMode: z.enum(TAB_GROUP_MODES).catch('flat'),
  sidebarCompletedRetentionDays: z.number().int().min(1).max(365).catch(DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS),
  agentTaskLifecyclePolicy: z.enum(['none', 'moderate', 'autonomous']).catch('moderate'),
  otel: otelPatchSchema.catch({}),
  textGenerationModel: modelSelectionSchema,
  backupTextGenerationModel: modelSelectionSchema,
  sourceControlWriterModel: modelSelectionSchema.nullable(),
  sourceControlWriting: sourceControlWritingPatchSchema.catch({}),
}).partial().strip()

export type HostConfigPatch = z.infer<typeof hostConfigPatchSchema>

/**
 * What a host answers with before any client has seeded it. Deliberately
 * platform-neutral: the host cannot know whether the client asking is a Mac
 * (`sf-pro-text`) or a phone (11px), so the first client to connect seeds those
 * from its own environment rather than adopting a wrong guess. See
 * `HostConfigSnapshot.seeded`.
 */
export const DEFAULT_HOST_CONFIG: HostConfig = {
  themeMode: 'dark',
  soundEnabled: true,
  voiceModeEnabled: false,
  autoSendVoiceTranscripts: false,
  vadSilenceMs: 1500,
  defaultEditor: 'vim',
  fallbackTerminal: 'default-terminal',
  activeAgent: 'claude-code',
  defaultModels: {},
  reviewAgent: null,
  reviewModel: null,
  reviewReasoning: null,
  stackedPrsEnabled: false,
  generatePrGuidesOnOpen: false,
  reviewWarmingByProject: {},
  rateLimitBehavior: 'ask',
  autoRenameSessions: true,
  showDiffSummaryAfterTurn: true,
  fontFamily: 'inter',
  fontSize: 13,
  codeFontFamily: 'jetbrains-mono',
  codeFontSize: 12,
  documentFontFamily: 'solus',
  documentFontSize: 16,
  extraInstructions: '',
  modelInstructions: {},
  analyticsEnabled: true,
  tabGroupMode: 'flat',
  sidebarCompletedRetentionDays: DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS,
  agentTaskLifecyclePolicy: 'moderate',
  otel: DEFAULT_OTEL_SETTINGS,
  textGenerationModel: { provider: 'codex', model: DEFAULT_TEXT_GENERATION_MODELS.codex },
  backupTextGenerationModel: {
    provider: 'claude-code',
    model: DEFAULT_TEXT_GENERATION_MODELS['claude-code'],
  },
  sourceControlWriterModel: null,
  sourceControlWriting: DEFAULT_SOURCE_CONTROL_WRITING,
}

/**
 * Which keys an agent may write, and which only the user may.
 *
 * Four are deliberately closed:
 *
 * - `analyticsEnabled` is a consent decision. An agent must never move it.
 * - `extraInstructions` and `modelInstructions` alter *every future turn* on
 *   this host. An agent reads issues, pages, and diffs written by other people;
 *   text in any of them could ask it to append a persistent instruction, and
 *   the change would outlive the conversation that caused it. Reading them is
 *   allowed, so an agent can still tell the user what to paste.
 * - `reviewWarmingByProject` is keyed by absolute host path. A key that does not
 *   match an existing project silently does nothing, which is a bad thing for a
 *   tool to be able to write.
 */
export const HOST_CONFIG_AGENT_WRITABLE = {
  themeMode: true,
  soundEnabled: true,
  voiceModeEnabled: true,
  autoSendVoiceTranscripts: true,
  vadSilenceMs: true,
  defaultEditor: true,
  fallbackTerminal: true,
  activeAgent: true,
  defaultModels: true,
  reviewAgent: true,
  reviewModel: true,
  reviewReasoning: true,
  stackedPrsEnabled: true,
  generatePrGuidesOnOpen: true,
  reviewWarmingByProject: false,
  rateLimitBehavior: true,
  autoRenameSessions: true,
  showDiffSummaryAfterTurn: true,
  fontFamily: true,
  fontSize: true,
  codeFontFamily: true,
  codeFontSize: true,
  documentFontFamily: true,
  documentFontSize: true,
  extraInstructions: false,
  modelInstructions: false,
  analyticsEnabled: false,
  tabGroupMode: true,
  sidebarCompletedRetentionDays: true,
  // Operator settings. These configure the machine, not the workspace, and two
  // of them can stop the host talking to anything: a wrong text-generation
  // model breaks every summary, a wrong collector silently drops telemetry.
  agentTaskLifecyclePolicy: false,
  otel: false,
  textGenerationModel: false,
  backupTextGenerationModel: false,
  sourceControlWriterModel: false,
  sourceControlWriting: false,
} as const satisfies Record<keyof HostConfig, boolean>

/**
 * Never sent to an agent in any form. `otel.headers` carries the credentials
 * for the operator's collector, and a denylist that has to be remembered per
 * key is how a secret eventually leaks — so the whole key is withheld.
 */
export const HOST_CONFIG_AGENT_HIDDEN_KEYS: readonly (keyof HostConfig)[] = ['otel']

const AGENT_WRITABLE_KEYS: ReadonlySet<string> = new Set(
  Object.entries(HOST_CONFIG_AGENT_WRITABLE)
    .filter(([, writable]) => writable)
    .map(([key]) => key),
)

export function isAgentWritableHostConfigKey(key: string): key is keyof HostConfig {
  return AGENT_WRITABLE_KEYS.has(key)
}

/** The writable keys, for a tool that has to tell an agent what it may set. */
export const AGENT_WRITABLE_HOST_CONFIG_KEYS: readonly string[] = [...AGENT_WRITABLE_KEYS].sort()

export interface HostConfigSnapshot {
  config: HostConfig
  /**
   * False until a client has written config to this host. A client that finds
   * `false` seeds the host from its own local settings — including the
   * platform-derived font defaults the host cannot compute — instead of
   * adopting `DEFAULT_HOST_CONFIG`. A client that finds `true` adopts what is
   * there, so the second device to connect inherits the first one's choices
   * rather than overwriting them.
   */
  seeded: boolean
}

/** Applies a validated patch. Only keys the patch actually carries change. */
export function mergeHostConfig(base: HostConfig, patch: HostConfigPatch): HostConfig {
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) Object.assign(next, { [key]: value })
  }
  // The nested keys merge onto the current value rather than replacing it: a
  // panel that toggles one switch sends one field, and replacing would blank
  // the endpoint the user typed a moment earlier. Normalization runs here,
  // after the merge, so it sees the whole object.
  if (patch.otel) next.otel = normalizeOtelSettings({ ...base.otel, ...patch.otel })
  if (patch.sourceControlWriting) {
    next.sourceControlWriting = normalizeSourceControlWriting({
      ...base.sourceControlWriting,
      ...patch.sourceControlWriting,
    })
  }
  return next
}
