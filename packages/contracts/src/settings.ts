// ─── Settings: personal, device, host, and organization ───
//
// plans/018-settings-sync-and-organization-policy.md. Every setting has one
// owner:
//
// - Personal: the person's choices. A local profile on each client, and the same
//   profile in their account when they turn sync on for that client. A host gets
//   the subset it runs work with (`ExecutionPreferences`) with that work.
// - Device: this client only — its microphone, its installed apps and fonts,
//   its consent to client analytics, its zoom and panes.
// - Host: the machine (`HostConfig` in `host-config.ts`).
// - Organization: the few settings an organization's owners decide for all its
//   work. Today that is only Sync all Insights.
//
// The personal schemas never heal: a wrong value is refused, because a synced
// document is the person's whole profile and a healed value is a choice they did
// not make. Device storage heals one bad key to its default.

import { z } from 'zod'
import type { SavedLens } from './review'
import { DEFAULT_MODEL_ROUTING, defaultLeadInstructions, modelRoutingSchema } from './model-routing'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  mergeNotificationPreferences,
  notificationPreferencesPatchSchema,
} from './notification-types'
import {
  DEFAULT_SOURCE_CONTROL_WRITING,
  EDITOR_IDS,
  PERMISSION_MODES,
  TERMINAL_APP_IDS,
  type AgentId,
  type AppCodeFontFamily,
  type AppFontFamily,
  type EditorId,
  type ReasoningEffort,
  type TerminalAppId,
} from './types'
import { DEFAULT_WORKTREE_BRANCH_NAMING, worktreeBranchNamingSchema } from './worktree-branch-naming'

// ─── Vocabulary ───

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResponseStreamingMode = 'buffered' | 'paragraph'
export type RateLimitBehavior = 'ask' | 'queue' | 'continue' | 'stop'
/**
 * A font choice as a client paints it: a bundled preset id, a surface sentinel
 * (`solus` for the document preset, `interface` for the prompt box), or an
 * installed family name from a device override.
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

/** Days a done task stays on the sidebar's Completed shelf. Display only: it deletes nothing. */
export const DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS = 2
/** How long a sidebar row takes to arrive, leave, or move, in milliseconds.
 *  0 turns the motion off (docs/plans/sidebar-motion.md). */
export const DEFAULT_SIDEBAR_MOTION_MS = 150
export const MAX_SIDEBAR_MOTION_MS = 600
/** The faintest reply text the Appearance slider allows, in percent. Below
 *  this, body text fails contrast on either theme. */
export const MIN_ASSISTANT_TEXT_OPACITY = 50
export const DEFAULT_REVIEW_AGENT: AgentId = 'codex'
export const DEFAULT_REVIEW_MODEL = 'gpt-6-luna'
export const DEFAULT_REVIEW_REASONING: ReasoningEffort = 'max'

export const DEFAULT_TEXT_GENERATION_MODELS = {
  codex: 'gpt-6-luna',
  'claude-code': 'claude-haiku-4-5-20251001',
} as const

export interface ModelOptions {
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  fastMode: boolean
}

export type ModelOptionsByProvider = Partial<Record<AgentId, Record<string, ModelOptions>>>

// ─── Personal settings ───

export type FontPreferenceKey = 'fontFamily' | 'codeFontFamily' | 'documentFontFamily' | 'promptFontFamily'

/** Bundled presets a synced font preference may name. An installed family stays a device override. */
export const APP_FONT_PRESETS = ['inter', 'dm-sans', 'system', 'geist', 'lora', 'sf-pro-text', 'sf-mono'] as const satisfies readonly AppFontFamily[]
export const APP_CODE_FONT_PRESETS = ['sf-mono', 'geist-mono', 'fira-code', 'cascadia-code', 'jetbrains-mono', 'system-mono'] as const satisfies readonly AppCodeFontFamily[]

export const FONT_PRESETS = {
  fontFamily: APP_FONT_PRESETS,
  codeFontFamily: APP_CODE_FONT_PRESETS,
  documentFontFamily: ['solus', ...APP_FONT_PRESETS],
  promptFontFamily: ['interface', ...APP_FONT_PRESETS, ...APP_CODE_FONT_PRESETS],
} as const satisfies Record<FontPreferenceKey, readonly string[]>

export const FONT_PREFERENCE_KEYS = Object.keys(FONT_PRESETS) as readonly FontPreferenceKey[]

export function isFontPreset(key: FontPreferenceKey, value: string): boolean {
  return (FONT_PRESETS[key] as readonly string[]).includes(value)
}

const AGENT_IDS = ['claude-code', 'codex', 'opencode'] as const satisfies readonly AgentId[]
const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const satisfies readonly ReasoningEffort[]
const MAX_INSTRUCTIONS = 20_000
const MAX_MODEL_ID = 200

const modelSelectionSchema = z.object({
  provider: z.enum(['codex', 'claude-code']),
  model: z.string().trim().min(1).max(MAX_MODEL_ID),
}).strict()

/** A lead or worker model, with the reasoning level it runs at; none runs at the model's default. */
const leadModelSelectionSchema = z.object({
  provider: z.enum(['codex', 'claude-code']),
  model: z.string().trim().min(1).max(MAX_MODEL_ID),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}).strict().transform((selection) => ({ provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }))

export type LeadModelSelection = z.output<typeof leadModelSelectionSchema>

function fontPresetSchema(key: FontPreferenceKey) {
  return z.string().refine((value) => isFontPreset(key, value), { message: `${key} must be a bundled preset` })
}

/** One strict schema per personal key: a wrong value is refused, never healed. */
export const PERSONAL_SETTING_SCHEMAS = {
  themeMode: z.enum(['system', 'light', 'dark']),
  activeAgent: z.enum(AGENT_IDS),
  defaultPermissionMode: z.enum(PERMISSION_MODES),
  notifications: notificationPreferencesPatchSchema.transform((patch) => mergeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES, patch)),
  modelRouting: modelRoutingSchema,
  defaultModels: z.record(z.string().max(MAX_MODEL_ID), z.string().max(MAX_MODEL_ID)).refine((value) => Object.keys(value).length <= 50),
  modelOptionsByProvider: z.partialRecord(z.enum(AGENT_IDS), z.record(z.string().max(MAX_MODEL_ID), z.object({
    reasoningEffort: z.enum(REASONING_EFFORTS),
    contextWindow: z.number().int().positive().nullable(),
    fastMode: z.boolean(),
  }).strict())),
  handoffHistoryTokens: z.number().int().min(1_024).max(1_000_000),
  reviewAgent: z.enum(AGENT_IDS),
  reviewModel: z.string().max(MAX_MODEL_ID),
  reviewReasoning: z.enum(REASONING_EFFORTS),
  reviewGuideInstructions: z.string().max(MAX_INSTRUCTIONS),
  savedLenses: z.array(z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(200),
    prompt: z.string().max(MAX_INSTRUCTIONS),
  }).strict()).max(100),
  generatePrGuidesOnOpen: z.boolean(),
  responseStreamingMode: z.enum(['buffered', 'paragraph']),
  rateLimitBehavior: z.enum(['ask', 'queue', 'continue', 'stop']),
  autoRenameSessions: z.boolean(),
  /** The transcript shows the tool calls between the agent's messages. */
  showToolCalls: z.boolean(),
  showDiffSummaryAfterTurn: z.boolean(),
  /** The composer tucks its toolbar row away while the keyboard is elsewhere. */
  collapseComposerWhenIdle: z.boolean(),
  fontFamily: fontPresetSchema('fontFamily'),
  fontSize: z.number().min(8).max(32),
  codeFontFamily: fontPresetSchema('codeFontFamily'),
  codeFontSize: z.number().min(8).max(32),
  documentFontFamily: fontPresetSchema('documentFontFamily'),
  documentFontSize: z.number().min(12).max(40),
  promptFontFamily: fontPresetSchema('promptFontFamily'),
  promptFontSize: z.number().min(8).max(32),
  /** Opacity of the agent's reply text, in percent. Headings keep full ink. */
  assistantTextOpacity: z.number().int().min(MIN_ASSISTANT_TEXT_OPACITY).max(100),
  /** Bounded because it is added to each agent run. */
  extraInstructions: z.string().max(MAX_INSTRUCTIONS),
  /** Extra instructions keyed by resolved model id, appended when that model runs. */
  modelInstructions: z.record(z.string().max(MAX_MODEL_ID), z.string().max(MAX_INSTRUCTIONS)).refine((value) => Object.keys(value).length <= 50),
  tabGroupMode: z.enum(TAB_GROUP_MODES),
  sidebarCompletedRetentionDays: z.number().int().min(1).max(365),
  sidebarMotionMs: z.number().int().min(0).max(MAX_SIDEBAR_MOTION_MS),
  /** The agent and model a new task lead starts on. Null means the default for new sessions. */
  leadModel: leadModelSelectionSchema.nullable(),
  agentTaskLifecyclePolicy: z.enum(['none', 'moderate', 'autonomous']),
  /** Rules added after the built-in lead contract (docs/plans/task-conversation.md). */
  leadInstructions: z.string().max(MAX_INSTRUCTIONS),
  /** The model a lead names for a worker when its instructions name none. Null leaves it to the lead. */
  workerModel: leadModelSelectionSchema.nullable(),
  textGenerationModel: modelSelectionSchema,
  /** Null falls back to `textGenerationModel`. */
  sourceControlWriterModel: modelSelectionSchema.nullable(),
  sourceControlWriting: z.object({
    mode: z.enum(['repo_conventions', 'conventional_commits', 'custom']),
    customInstructions: z.string().max(8_000),
    followPullRequestTemplate: z.boolean(),
  }).strict(),
  /** A project's `.solus/config.json` can override it (docs/worktree-names.md). */
  worktreeBranchNaming: worktreeBranchNamingSchema,
}

export const personalSettingsSchema = z.object(PERSONAL_SETTING_SCHEMAS).strict()
/** The person's settings, whole. */
export type PersonalSettings = z.output<typeof personalSettingsSchema>
export type PersonalSettingKey = keyof PersonalSettings

export const PERSONAL_SETTING_KEYS = Object.keys(PERSONAL_SETTING_SCHEMAS) as readonly PersonalSettingKey[]

/**
 * A stored or sent personal document: any subset of the keys. An absent key is
 * one the person never set, and reads as the default. Unknown keys — including
 * every host, device, and secret key — are refused.
 */
export const personalSettingsDocumentSchema = personalSettingsSchema.partial().strict()
export type PersonalSettingsDocument = z.output<typeof personalSettingsDocumentSchema>

/** The saved lens included by default on every client. */
export const SHOW_ME_LENS: SavedLens = {
  id: 'show-me',
  name: 'Show me',
  prompt: 'Read the show-me skill at https://raw.githubusercontent.com/humanlayer/skills/refs/heads/main/plugins/show-me/skills/show-me/SKILL.md and follow it to help me understand this change visually. Put every view in this lens: draw Mermaid-style diagrams as inline SVG, and do not open a file.',
}

/** Upgrade an existing saved list once; keep its order and any Show me edits. */
export function addShowMeLens(document: PersonalSettingsDocument): PersonalSettingsDocument {
  const lenses = document.savedLenses
  if (!lenses || lenses.length >= 100) return document
  if (lenses.some((lens) => lens.id === SHOW_ME_LENS.id || lens.name === SHOW_ME_LENS.name || lens.prompt === SHOW_ME_LENS.prompt)) return document
  return { ...document, savedLenses: [...lenses, structuredClone(SHOW_ME_LENS)] }
}

/** The defaults a client shows before the person chooses. */
export const DEFAULT_PERSONAL_SETTINGS: PersonalSettings = {
  themeMode: 'system',
  activeAgent: 'claude-code',
  defaultPermissionMode: 'full-access',
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
  modelRouting: DEFAULT_MODEL_ROUTING,
  defaultModels: {},
  modelOptionsByProvider: {},
  handoffHistoryTokens: 16_000,
  reviewAgent: DEFAULT_REVIEW_AGENT,
  reviewModel: DEFAULT_REVIEW_MODEL,
  reviewReasoning: DEFAULT_REVIEW_REASONING,
  reviewGuideInstructions: '',
  savedLenses: [SHOW_ME_LENS],
  generatePrGuidesOnOpen: false,
  responseStreamingMode: 'paragraph',
  rateLimitBehavior: 'ask',
  autoRenameSessions: true,
  showToolCalls: true,
  showDiffSummaryAfterTurn: true,
  collapseComposerWhenIdle: true,
  fontFamily: 'system',
  fontSize: 16,
  codeFontFamily: 'jetbrains-mono',
  codeFontSize: 12,
  documentFontFamily: 'solus',
  documentFontSize: 16,
  promptFontFamily: 'interface',
  promptFontSize: 13,
  assistantTextOpacity: 100,
  extraInstructions: '',
  modelInstructions: {},
  tabGroupMode: 'flat',
  sidebarCompletedRetentionDays: DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS,
  sidebarMotionMs: DEFAULT_SIDEBAR_MOTION_MS,
  leadModel: null,
  agentTaskLifecyclePolicy: 'moderate',
  leadInstructions: defaultLeadInstructions(DEFAULT_MODEL_ROUTING),
  workerModel: null,
  textGenerationModel: { provider: 'codex', model: DEFAULT_TEXT_GENERATION_MODELS.codex },
  sourceControlWriterModel: null,
  sourceControlWriting: DEFAULT_SOURCE_CONTROL_WRITING,
  worktreeBranchNaming: DEFAULT_WORKTREE_BRANCH_NAMING,
}

/** Personal values, document over defaults. Cloned so a caller may mutate the result. */
export function personalSettingsWithDefaults(document: PersonalSettingsDocument, defaults: PersonalSettings = DEFAULT_PERSONAL_SETTINGS): PersonalSettings {
  return structuredClone({ ...defaults, ...document })
}

/** A synced document is small. A larger one is a paste gone wrong, refused before it is stored. */
export const MAX_PERSONAL_SETTINGS_BYTES = 128 * 1024
export const PERSONAL_SETTINGS_SCHEMA_VERSION = 1

export function personalSettingsByteLength(document: PersonalSettingsDocument): number {
  return new TextEncoder().encode(JSON.stringify(document)).byteLength
}

// ─── Execution preferences ───

/**
 * The personal keys a host reads while it runs work for a person (plans/018 §6):
 * the subset a client sends with a turn, and a background record (an automation)
 * captures so it runs the same way while the client is absent. The host never
 * reads these from its own config for a person's work.
 */
export const EXECUTION_PREFERENCE_KEYS = [
  'defaultPermissionMode',
  'modelRouting',
  'handoffHistoryTokens',
  'responseStreamingMode',
  'rateLimitBehavior',
  'autoRenameSessions',
  'extraInstructions',
  'modelInstructions',
  'leadModel',
  'agentTaskLifecyclePolicy',
  'leadInstructions',
  'workerModel',
  'textGenerationModel',
  'sourceControlWriterModel',
  'sourceControlWriting',
  'worktreeBranchNaming',
] as const satisfies readonly PersonalSettingKey[]
export type ExecutionPreferenceKey = (typeof EXECUTION_PREFERENCE_KEYS)[number]

/** What a client sends: any subset. An absent key reads as the built-in default. */
export type ExecutionPreferences = Partial<Pick<PersonalSettings, ExecutionPreferenceKey>>

/** The built-in values for work no person's preference describes (an operation with no accountable actor). */
export const DEFAULT_EXECUTION_PREFERENCES = executionPreferenceDefaultsOf()

function executionPreferenceDefaultsOf(): Pick<PersonalSettings, ExecutionPreferenceKey> {
  // SAFETY: the entries are exactly `EXECUTION_PREFERENCE_KEYS`, each with its `DEFAULT_PERSONAL_SETTINGS` value.
  return Object.fromEntries(EXECUTION_PREFERENCE_KEYS.map((key) => [key, DEFAULT_PERSONAL_SETTINGS[key]])) as Pick<PersonalSettings, ExecutionPreferenceKey>
}

/**
 * Parses execution preferences at the boundary they arrive over (plans/018 §6).
 * Strict: an unknown key or a bad value refuses the request. A value is never
 * healed into a choice the person did not make.
 */
export const executionPreferencesSchema = personalSettingsSchema
  .pick(Object.fromEntries(EXECUTION_PREFERENCE_KEYS.map((key) => [key, true])) as { [K in ExecutionPreferenceKey]: true })
  .partial()
  .strict() satisfies z.ZodType<ExecutionPreferences, unknown>

/** The preferences a background record runs with: the ones its creator or last editor sent. */
export interface ExecutionPreferenceSnapshot {
  capturedAt: number
  preferences: ExecutionPreferences
}

export const executionPreferenceSnapshotSchema = z.object({
  capturedAt: z.number(),
  preferences: executionPreferencesSchema,
}) satisfies z.ZodType<ExecutionPreferenceSnapshot, unknown>

// ─── Device settings ───

/**
 * The client's own layout and navigation keys (`DEVICE_LAYOUT_KEYS` in the
 * workspace device store). They never leave the device; listed here so a test can
 * hold the client table to this one.
 */
export const CLIENT_DEVICE_LAYOUT_KEYS = [
  'zoomFactor',
  'typographyAdvanced',
  'keybindings',
  'projectPanelOpen',
  'splitProjectPanelOpen',
  'projectPanelWidth',
  'splitProjectPanelWidth',
  'projectPanelCollapsed',
  'splitProjectPanelCollapsed',
  'sidebarProjectFilter',
  'lastProject',
  'onboardingCompleted',
] as const

/**
 * What stays with one client install or browser profile. The four font overrides
 * hold an installed family name that masks the synced preset on this device only;
 * null follows the synced preset. `clientAnalyticsEnabled` is null until the
 * person decides: no sign-in or sync may decide it for them.
 */
export interface DeviceSettings {
  voiceModeEnabled: boolean
  autoSendVoiceTranscripts: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  /** Terminal opened only when no terminal is attached to the shared tmux session. */
  fallbackTerminal: TerminalAppId | null
  fontSmoothing: boolean
  clientAnalyticsEnabled: boolean | null
  fontFamilyOverride: string | null
  codeFontFamilyOverride: string | null
  documentFontFamilyOverride: string | null
  promptFontFamilyOverride: string | null
}

export const FONT_OVERRIDE_KEYS = {
  fontFamily: 'fontFamilyOverride',
  codeFontFamily: 'codeFontFamilyOverride',
  documentFontFamily: 'documentFontFamilyOverride',
  promptFontFamily: 'promptFontFamilyOverride',
} as const satisfies Record<FontPreferenceKey, keyof DeviceSettings>

const fontOverrideSchema = z.string().trim().min(1).max(FONT_FAMILY_PREFERENCE_MAX_LENGTH).nullable().catch(null)

/** Local storage heals: a bad device key falls back on its own and costs nothing else. */
export const deviceSettingsSchema = z.object({
  voiceModeEnabled: z.boolean().catch(false),
  autoSendVoiceTranscripts: z.boolean().catch(false),
  vadSilenceMs: z.number().transform((value) => Math.max(1000, Math.min(8000, value))).catch(1500),
  defaultEditor: z.enum(EDITOR_IDS).nullable().catch(null),
  fallbackTerminal: z.enum(TERMINAL_APP_IDS).nullable().catch(null),
  fontSmoothing: z.boolean().catch(true),
  clientAnalyticsEnabled: z.boolean().nullable().catch(null),
  fontFamilyOverride: fontOverrideSchema,
  codeFontFamilyOverride: fontOverrideSchema,
  documentFontFamilyOverride: fontOverrideSchema,
  promptFontFamilyOverride: fontOverrideSchema,
}) satisfies z.ZodType<DeviceSettings, unknown>

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  voiceModeEnabled: false,
  autoSendVoiceTranscripts: false,
  vadSilenceMs: 1500,
  defaultEditor: 'vim',
  fallbackTerminal: 'default-terminal',
  fontSmoothing: true,
  clientAnalyticsEnabled: null,
  fontFamilyOverride: null,
  codeFontFamilyOverride: null,
  documentFontFamilyOverride: null,
  promptFontFamilyOverride: null,
}

/** The font this device paints: its own installed family when set, else the synced preset. */
export function effectiveFontFamily(key: FontPreferenceKey, personal: Pick<PersonalSettings, FontPreferenceKey>, device: Pick<DeviceSettings, (typeof FONT_OVERRIDE_KEYS)[FontPreferenceKey]>): { family: string; overridden: boolean } {
  const override = device[FONT_OVERRIDE_KEYS[key]]
  return override ? { family: override, overridden: true } : { family: personal[key], overridden: false }
}

// ─── Organization settings ───

/**
 * What an organization's owners decide for all its work, from any client's
 * Settings. Only `syncAllInsights` today: on, every session of the organization
 * sends its Insights and members cannot turn it off. The control plane stores it
 * in the organization's host policy and delivers it to hosts in their standing,
 * where Insights delivery already applies it. Host eligibility and provisioning
 * defaults stay in the console; a client cannot change them. A new key here needs
 * its own enforcement point and an explicit product decision (plans/018 §3.4).
 */
export const organizationSettingsSchema = z.object({
  syncAllInsights: z.boolean(),
}).strict()
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>

/** `GET /v1/orgs/:organizationId/settings`: the settings and what the caller may do. */
export const organizationSettingsResponseSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string(),
  /** Computed by the control plane from current membership. Owners only. */
  canManageSettings: z.boolean(),
  revision: z.number().int().nonnegative(),
  settings: organizationSettingsSchema,
})
export type OrganizationSettingsResponse = z.infer<typeof organizationSettingsResponseSchema>

/** `PATCH /v1/orgs/:organizationId/settings`. Only the keys carried change. */
export const organizationSettingsPatchRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  settings: organizationSettingsSchema.partial().strict(),
}).strict()
export type OrganizationSettingsPatchRequest = z.infer<typeof organizationSettingsPatchRequestSchema>

/** A 409 on an organization write: someone saved first. The body carries what they saved. */
export const organizationSettingsConflictBodySchema = z.object({
  error: z.literal('settings_conflict'),
  current: organizationSettingsResponseSchema,
})

// ─── Account settings (personal sync) ───

/**
 * `GET /v1/account/settings`. `revision` is null while the account has no synced
 * document. `generation` grows each time the person clears synced settings; a
 * client holding an older generation must stop and be turned on again.
 */
export const accountSettingsResponseSchema = z.object({
  schemaVersion: z.literal(PERSONAL_SETTINGS_SCHEMA_VERSION),
  generation: z.number().int().nonnegative(),
  revision: z.number().int().positive().nullable(),
  settings: personalSettingsDocumentSchema,
  updatedAt: z.number().nullable(),
})
export type AccountSettingsResponse = z.infer<typeof accountSettingsResponseSchema>

/**
 * `PATCH /v1/account/settings`. `set` replaces each key it carries; `reset` removes
 * keys so they read as defaults. The conflict unit is one top-level key; an array
 * such as `savedLenses` is one unit. `expectedRevision: null` creates the document
 * and fails when one already exists.
 */
export const accountSettingsPatchRequestSchema = z.object({
  generation: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive().nullable(),
  set: personalSettingsDocumentSchema,
  reset: z.array(z.enum(PERSONAL_SETTING_KEYS as [PersonalSettingKey, ...PersonalSettingKey[]])).max(PERSONAL_SETTING_KEYS.length).default([]),
}).strict()
export type AccountSettingsPatchRequest = z.input<typeof accountSettingsPatchRequestSchema>

/** A 409 on an account write: a stale revision or a cleared generation. */
export const accountSettingsConflictBodySchema = z.object({
  error: z.enum(['settings_conflict', 'settings_generation_changed']),
  current: accountSettingsResponseSchema,
})

export const ACCOUNT_SETTINGS_PATH = '/v1/account/settings'
export const organizationSettingsPath = (organizationId: string): string => `/v1/orgs/${encodeURIComponent(organizationId)}/settings`
