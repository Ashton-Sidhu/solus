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
import { DEFAULT_MODEL_ROUTING, modelRoutingSchema, type ModelRouting } from './model-routing'
import { CONFIGURABLE_SOLUS_TOOL_NAMES, withoutRetiredSolusTools, type SolusToolPreferences } from './agent-tools'
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
import type { SavedLens } from './review'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  mergeNotificationPreferences,
  notificationPreferencesPatchSchema,
  type NotificationPreferences,
} from './notification-types'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResponseStreamingMode = 'buffered' | 'paragraph'
export type RateLimitBehavior = 'ask' | 'queue' | 'continue' | 'stop'
/**
 * A font choice: a bundled preset id, one of the surface's own sentinels
 * (`solus` for the document preset, `interface` for the prompt box), or the
 * name of a family installed on the client, the way a native editor lists
 * system fonts. The client resolves the string to a stack; the host only
 * stores it, so the set is open and bounded by length alone.
 */
export type FontFamilyPreference = string
/** Longer than any real family name; a paste of prose is not a font. */
export const FONT_FAMILY_PREFERENCE_MAX_LENGTH = 120
export type DocumentFontFamily = 'solus' | AppFontFamily
/** The prompt box follows the interface font unless the user picks a face for
 *  it alone; a monospace face is allowed because a prompt is often code. */
export type PromptFontFamily = 'interface' | AppFontFamily | AppCodeFontFamily

export const TAB_GROUP_MODES = ['flat', 'status', 'unread'] as const
export type TabGroupMode = (typeof TAB_GROUP_MODES)[number]

/** Days a done task stays on the sidebar's Completed shelf. Lives here because
 *  it is the default of a host-config key; `lib/completed-task-retention`
 *  re-exports it so renderer call sites keep one import. */
export const DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS = 2
/** How long a sidebar row takes to arrive, leave, or move, in milliseconds.
 *  0 turns the motion off (docs/plans/sidebar-motion.md). */
export const DEFAULT_SIDEBAR_MOTION_MS = 150
export const MAX_SIDEBAR_MOTION_MS = 600
export const DEFAULT_REVIEW_AGENT: AgentId = 'codex'
export const DEFAULT_REVIEW_MODEL = 'gpt-6-sol'
export const DEFAULT_REVIEW_REASONING: ReasoningEffort = 'medium'

export interface HostConfig {
  solusTools: SolusToolPreferences
  themeMode: ThemeMode
  voiceModeEnabled: boolean
  autoSendVoiceTranscripts: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  fallbackTerminal: TerminalAppId | null
  activeAgent: AgentId
  defaultPermissionMode: 'ask' | 'auto' | 'plan'
  /** Which events notify, and through which channels. */
  notifications: NotificationPreferences
  /** Per-agent model for new sessions; a missing entry means that agent's built-in default. */
  modelRouting: ModelRouting
  defaultModels: Record<string, string>
  reviewAgent: AgentId
  reviewModel: string
  reviewReasoning: ReasoningEffort
  /** User instructions applied only when a review guide is authored. */
  reviewGuideInstructions: string
  /** Named lens prompts the user can run on any review target. */
  savedLenses: SavedLens[]
  generatePrGuidesOnOpen: boolean
  /**
   * Keyed by project path. Host config rather than device config because the
   * key is a path on this host — the same map on another machine would name
   * directories that do not exist there.
   */
  reviewWarmingByProject: Record<string, boolean>
  responseStreamingMode: ResponseStreamingMode
  rateLimitBehavior: RateLimitBehavior
  autoRenameSessions: boolean
  /** File new sessions under a task. Off: a session starts with no task and
   *  the composer hides its task picker. */
  tasksEnabled: boolean
  showDiffSummaryAfterTurn: boolean
  /** The composer tucks its toolbar row away while the keyboard is elsewhere. */
  collapseComposerWhenIdle: boolean
  /** `AppFontFamily` preset or an installed family name. */
  fontFamily: FontFamilyPreference
  fontSize: number
  /** `AppCodeFontFamily` preset or an installed monospace family name. */
  codeFontFamily: FontFamilyPreference
  codeFontSize: number
  /** `DocumentFontFamily` preset or an installed family name. */
  documentFontFamily: FontFamilyPreference
  documentFontSize: number
  /** `PromptFontFamily` preset or an installed family name. */
  promptFontFamily: FontFamilyPreference
  promptFontSize: number
  /** Grayscale `antialiased` text; false keeps the heavier platform default.
   *  Only macOS engines honor the property, so elsewhere it is inert. */
  fontSmoothing: boolean
  /** App-wide user instructions added through each provider's instruction extension point. */
  extraInstructions: string
  /** Extra instructions keyed by resolved model id, appended when that model runs. */
  modelInstructions: Record<string, string>
  analyticsEnabled: boolean
  tabGroupMode: TabGroupMode
  archivedAutomationRetentionDays: number
  sidebarCompletedRetentionDays: number
  /** Sidebar row motion, in milliseconds; 0 turns it off. */
  sidebarMotionMs: number

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
  /** Null means fall back to `textGenerationModel`. */
  sourceControlWriterModel: TextGenerationModelSelection | null
  sourceControlWriting: SourceControlWritingPreferences
}

/** Trimmed; an empty or oversized string heals to the surface's default. */
const fontFamilyPreferenceSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(FONT_FAMILY_PREFERENCE_MAX_LENGTH))
const AGENT_IDS = ['claude-code', 'codex', 'opencode'] as const satisfies readonly AgentId[]
const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const satisfies readonly ReasoningEffort[]

export const DEFAULT_OTEL_SETTINGS: OtelSettings = {
  enabled: false,
  endpoint: '',
  headers: '',
  exportMetrics: true,
  exportTraces: true,
}

export const DEFAULT_TEXT_GENERATION_MODELS = {
  codex: 'gpt-6-luna',
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
 * One row per key. Everything the host and its clients need to know about a
 * config key — how a patch value validates, what the key is before anyone sets
 * it, and whether an agent may write it — is declared here once; the patch
 * schema, the defaults, and the agent policy are read off this table.
 *
 * `patch` is what a partial update validates as. Every field self-heals with
 * `.catch`, so a hand-edited or partially-written config never costs a user
 * their whole settings blob — only the one key that is wrong falls back to its
 * default. The exceptions are the keys where a wrong value is worse than a
 * refused one (`solusTools`, `archivedAutomationRetentionDays`, the model
 * selections) and the nested keys, whose patch is a partial that
 * `mergeHostConfig` lays over the current value.
 *
 * `default` is what a host answers with before any client has seeded it.
 * Deliberately platform-neutral: the host cannot know whether the client
 * asking is a Mac (`sf-pro-text`) or a phone (11px), so the first client to
 * connect seeds those from its own environment rather than adopting a wrong
 * guess. See `HostConfigSnapshot.seeded`.
 *
 * `agentWritable` is which keys an agent may set, and which only the user may.
 * Four are deliberately closed:
 *
 * - `analyticsEnabled` is a consent decision. An agent must never move it.
 * - `extraInstructions`, `modelInstructions`, `reviewGuideInstructions`, and
 *   `savedLenses`
 *   alter future agent runs on this host. An agent reads issues, pages, and
 *   diffs written by other people; text in any of them could ask it to append
 *   a persistent instruction, and the change would outlive the conversation
 *   that caused it. Reading them is allowed, so an agent can still tell the
 *   user what to paste.
 * - `reviewWarmingByProject` is keyed by absolute host path. A key that does
 *   not match an existing project silently does nothing, which is a bad thing
 *   for a tool to be able to write.
 *
 * The operator settings are closed too. They configure the machine, not the
 * workspace, and two of them can stop the host talking to anything: a wrong
 * text-generation model breaks every summary, a wrong collector silently drops
 * telemetry.
 */
interface HostConfigField<Value, Patch> {
  patch: z.ZodType<Patch, unknown>
  default: Value
  agentWritable: boolean
}

type HostConfigFieldTable = { [K in keyof HostConfig]: HostConfigField<HostConfig[K], unknown> }

function field<const Value, Patch>(
  patch: z.ZodType<Patch, unknown>,
  defaultValue: Value,
  agentWritable: boolean,
): HostConfigField<Value, Patch> {
  return { patch, default: defaultValue, agentWritable }
}

export const HOST_CONFIG_FIELDS = {
  solusTools: field(z.record(z.string(), z.boolean()).transform(withoutRetiredSolusTools).pipe(z.partialRecord(z.enum(CONFIGURABLE_SOLUS_TOOL_NAMES), z.boolean())), {}, false),
  themeMode: field(z.enum(['system', 'light', 'dark']).catch('system'), 'system', true),
  voiceModeEnabled: field(z.boolean().catch(false), false, true),
  autoSendVoiceTranscripts: field(z.boolean().catch(false), false, true),
  vadSilenceMs: field(z.number().transform((value) => Math.max(1000, Math.min(8000, value))).catch(1500), 1500, true),
  defaultEditor: field(z.enum(EDITOR_IDS).nullable().catch(null), 'vim', true),
  fallbackTerminal: field(z.enum(TERMINAL_APP_IDS).nullable().catch(null), 'default-terminal', true),
  activeAgent: field(z.enum(AGENT_IDS).catch('claude-code'), 'claude-code', true),
  defaultPermissionMode: field(z.enum(['ask', 'auto', 'plan']).catch('auto'), 'auto', false),
  notifications: field(notificationPreferencesPatchSchema.catch({}), DEFAULT_NOTIFICATION_PREFERENCES, true),
  modelRouting: field(modelRoutingSchema.catch(DEFAULT_MODEL_ROUTING), DEFAULT_MODEL_ROUTING, true),
  defaultModels: field(z.record(z.string(), z.string()).catch({}), {}, true),
  reviewAgent: field(z.enum(AGENT_IDS).catch(DEFAULT_REVIEW_AGENT), DEFAULT_REVIEW_AGENT, true),
  reviewModel: field(z.string().catch(DEFAULT_REVIEW_MODEL), DEFAULT_REVIEW_MODEL, true),
  reviewReasoning: field(z.enum(REASONING_EFFORTS).catch(DEFAULT_REVIEW_REASONING), DEFAULT_REVIEW_REASONING, true),
  reviewGuideInstructions: field(z.string().max(20_000).catch(''), '', false),
  savedLenses: field(z.array(z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(200),
    prompt: z.string().max(20_000),
  })).max(100).catch([]), [], false),
  generatePrGuidesOnOpen: field(z.boolean().catch(false), false, true),
  reviewWarmingByProject: field(z.record(z.string(), z.boolean()).catch({}), {}, false),
  responseStreamingMode: field(z.enum(['buffered', 'paragraph']).catch('paragraph'), 'paragraph', true),
  rateLimitBehavior: field(z.enum(['ask', 'queue', 'continue', 'stop']).catch('ask'), 'ask', true),
  autoRenameSessions: field(z.boolean().catch(true), true, true),
  tasksEnabled: field(z.boolean().catch(true), true, true),
  showDiffSummaryAfterTurn: field(z.boolean().catch(true), true, true),
  collapseComposerWhenIdle: field(z.boolean().catch(true), true, true),
  fontFamily: field(fontFamilyPreferenceSchema.catch('inter'), 'inter', true),
  fontSize: field(z.number().min(8).max(32).catch(16), 16, true),
  codeFontFamily: field(fontFamilyPreferenceSchema.catch('jetbrains-mono'), 'jetbrains-mono', true),
  codeFontSize: field(z.number().min(8).max(32).catch(12), 12, true),
  documentFontFamily: field(fontFamilyPreferenceSchema.catch('solus'), 'solus', true),
  documentFontSize: field(z.number().min(12).max(40).catch(16), 16, true),
  promptFontFamily: field(fontFamilyPreferenceSchema.catch('interface'), 'interface', true),
  promptFontSize: field(z.number().min(8).max(32).catch(13), 13, true),
  fontSmoothing: field(z.boolean().catch(true), true, true),
  // Bounded because it is added to each agent run: an accidental paste of a
  // whole file would silently eat the context window.
  extraInstructions: field(z.string().max(20_000).catch(''), '', false),
  modelInstructions: field(z.record(z.string(), z.string().max(20_000)).catch({}), {}, false),
  analyticsEnabled: field(z.boolean().catch(true), true, false),
  tabGroupMode: field(z.enum(TAB_GROUP_MODES).catch('flat'), 'flat', true),
  archivedAutomationRetentionDays: field(z.number().int().min(1).max(3650), 30, false),
  sidebarCompletedRetentionDays: field(
    z.number().int().min(1).max(365).catch(DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS),
    DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS,
    true,
  ),
  sidebarMotionMs: field(
    z.number().int().min(0).max(MAX_SIDEBAR_MOTION_MS).catch(DEFAULT_SIDEBAR_MOTION_MS),
    DEFAULT_SIDEBAR_MOTION_MS,
    true,
  ),
  agentTaskLifecyclePolicy: field(z.enum(['none', 'moderate', 'autonomous']).catch('moderate'), 'moderate', false),
  otel: field(otelPatchSchema.catch({}), DEFAULT_OTEL_SETTINGS, false),
  textGenerationModel: field(
    modelSelectionSchema,
    { provider: 'codex', model: DEFAULT_TEXT_GENERATION_MODELS.codex },
    false,
  ),
  sourceControlWriterModel: field(modelSelectionSchema.nullable(), null, false),
  sourceControlWriting: field(sourceControlWritingPatchSchema.catch({}), DEFAULT_SOURCE_CONTROL_WRITING, false),
} satisfies HostConfigFieldTable

export type HostConfigKey = keyof typeof HOST_CONFIG_FIELDS

export function isHostConfigKey(key: string): key is HostConfigKey {
  return Object.hasOwn(HOST_CONFIG_FIELDS, key)
}

export const HOST_CONFIG_KEYS: readonly HostConfigKey[] = Object.keys(HOST_CONFIG_FIELDS).filter(isHostConfigKey)

type HostConfigColumn<Column extends keyof HostConfigField<unknown, unknown>> = {
  [K in HostConfigKey]: (typeof HOST_CONFIG_FIELDS)[K][Column]
}

/** One column of the table, read out as an object keyed like the table. */
function column<Column extends keyof HostConfigField<unknown, unknown>>(name: Column): HostConfigColumn<Column> {
  // SAFETY: every `HostConfigKey` contributes one entry, so the result has exactly the table's keys.
  return Object.fromEntries(HOST_CONFIG_KEYS.map((key) => [key, HOST_CONFIG_FIELDS[key][name]])) as HostConfigColumn<Column>
}

export const hostConfigPatchSchema = z.object(column('patch')).partial().strip()

export type HostConfigPatch = z.infer<typeof hostConfigPatchSchema>

export const DEFAULT_HOST_CONFIG: HostConfig = column('default')

export const HOST_CONFIG_AGENT_WRITABLE: Record<HostConfigKey, boolean> = column('agentWritable')

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

export interface TypeSafeKeyStatus {
  source: 'saved' | 'environment' | null
}

export interface HostConfigSnapshot {
  /** Absent on older hosts. Contains no credential value. */
  typeSafe?: TypeSafeKeyStatus
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
  if (patch.solusTools) next.solusTools = { ...base.solusTools, ...patch.solusTools }
  if (patch.notifications) {
    next.notifications = mergeNotificationPreferences(base.notifications, patch.notifications)
  }
  return next
}
