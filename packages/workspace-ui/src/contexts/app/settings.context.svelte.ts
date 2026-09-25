/** Unified settings context: theme + editor/terminal/agent + worktree toggle. */

import { z } from 'zod'

import { createAppContext } from './create-app-context'
import { TERMINAL_APP_IDS, type AppCodeFontFamily, type AppFontFamily, type SettingsCtx } from '@solus/contracts/types'
import type { KeyCombo } from '../../lib/keybindings/types'
import { KEYBINDINGS } from '../../lib/keybindings/manifest'
import { setAnalyticsEnabled } from '../../lib/analytics'
import { MOBILE_QUERY } from './viewport'
import { runtime } from './runtime.svelte'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { clampZoomFactor, defaultZoomFactorForScreen, stepZoomFactor, ZOOM_FACTOR_DEFAULT } from '@solus/contracts/zoom'
import { DEFAULT_HOST_CONFIG, HOST_CONFIG_FIELDS, MAX_SIDEBAR_MOTION_MS } from '@solus/contracts/host-config'
import type { HostConfig, HostConfigKey } from '@solus/contracts/host-config'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { DocumentFontFamily, FontFamilyPreference, PromptFontFamily } from '@solus/contracts/host-config'
import { customFamilyStack } from '../../lib/font-family'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  mergeNotificationPreferences,
  notificationPreferencesPatchSchema,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from '@solus/contracts/notification-types'

// Host-config vocabulary lives in the contract, because the host validates the
// same values. Re-exported so renderer call sites keep one import.
export { TAB_GROUP_MODES } from '@solus/contracts/host-config'
export type {
  DocumentFontFamily,
  FontFamilyPreference,
  PromptFontFamily,
  RateLimitBehavior,
  TabGroupMode,
  ThemeMode,
} from '@solus/contracts/host-config'

export type ProjectPanelSectionId = 'goal' | 'environment' | 'git' | 'task' | 'subagents' | 'watches' | 'automations'
const DEFAULT_PROJECT_PANEL_COLLAPSED = {
  // The section only exists while a goal is set, so it opens on arrival — a
  // collapsed default would hide the thing the user just asked to see.
  goal: false,
  environment: false,
  git: false,
  // The card only exists while the session is bound to a task, so it opens on
  // arrival — the same reasoning as the goal section above.
  task: true,
  // The section only exists once the session has dispatched a sub-agent, and
  // a live fan-out is the thing the reader wants to watch — so it opens.
  subagents: false,
  // The section only exists while the session has an active watch, which is a
  // wait the person may want to stop — so it opens.
  watches: false,
  automations: true,
} as const satisfies Record<ProjectPanelSectionId, boolean>

/** Safari does not paint `theme-color` neat: it lays a translucent white
 *  material over the toolbars, so chrome fed the app's own edge colour renders
 *  several steps lighter than the page it borders — exactly the seam the
 *  theme-color was there to remove. Measured at ~15% white against the dark
 *  edge on current iOS Safari. */
const TOOLBAR_MATERIAL_ALPHA = 0.15

/** The colour that resolves to `hex` once Safari's toolbar material is over it.
 *  A light edge is already near white, so the correction is invisible there and
 *  only the dark theme moves. */
function toolbarTint(hex: string): string {
  const channels = [1, 3, 5].map((offset) => {
    const painted = Number.parseInt(hex.slice(offset, offset + 2), 16)
    const beneath = (painted - 255 * TOOLBAR_MATERIAL_ALPHA) / (1 - TOOLBAR_MATERIAL_ALPHA)
    return Math.round(Math.min(255, Math.max(0, beneath)))
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`
}

function applyTheme(isDark: boolean): void {
  // The opaque form of `--solus-container-bg`. Every web surface — the mobile
  // shell and the desktop root alike — paints that colour edge to edge, so the
  // page background and Safari's toolbar have to *render* as the same value or
  // the seam between browser chrome and app reads as two different blacks. The
  // page takes it neat; the toolbar takes it through `toolbarTint`.
  const edgeColor = isDark ? '#262522' : '#fefefc'
  const isWebShell = document.documentElement.classList.contains('solus-web')
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.classList.toggle('light', !isDark)
  document.documentElement.style.setProperty('color-scheme', isDark ? 'dark' : 'light')
  if (isWebShell) {
    document.documentElement.style.setProperty('background-color', edgeColor)
    document.body?.style.setProperty('background-color', edgeColor)
  }

  const tint = toolbarTint(edgeColor)
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = tint
    meta.removeAttribute('media')
  }

  document
    .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', isDark ? 'black-translucent' : 'default')
}

/** The "Interface size" number reads like a root font-size: 16 is the fixed
 *  16px root (ADR-0010) at scale 1, so the content rungs in index.css resolve
 *  to their stated sizes (`--text-body` = 0.875rem × scale = 14px prose). */
const BASE_FONT_SIZE = 16
const DEFAULT_FONT_SIZE = globalThis.matchMedia?.(MOBILE_QUERY).matches ? 14 : 16

function applyFontSize(size: number): void {
  document.documentElement.style.setProperty('--solus-font-scale', String(size / BASE_FONT_SIZE))
}

/** Desktop-only: the web client leans on native browser zoom instead, so the
 *  bridge method is absent there and this is a no-op. */
function applyZoomFactor(factor: number): void {
  localApi.setZoomFactor?.(factor)
  // Layout branches keyed on the display need the factor to read `screen.width`
  // honestly — Chromium reports it in zoomed CSS pixels.
  runtime.setZoomFactor(factor)
}

/** Zoom is a desktop shell capability; on web and mobile the browser owns it,
 *  so there is nothing to seed and the stored factor stays at 100%. */
const DEFAULT_ZOOM_FACTOR =
  localApi.setZoomFactor === undefined
    ? ZOOM_FACTOR_DEFAULT
    : defaultZoomFactorForScreen(globalThis.screen?.width)

export const IS_MAC_OS = /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? '')
const DEFAULT_APP_FONT_FAMILY: AppFontFamily = IS_MAC_OS ? 'sf-pro-text' : 'inter'

// `weight` is the body weight tuned for crispest rendering of each typeface at
// ~13px under grayscale antialiasing (-webkit-font-smoothing: antialiased).
// Grayscale AA thins glyphs, so Inter/DM Sans need the 500 (Medium named
// instance) bump or they look washed out. Grotesque, system and serif faces
// render heavier — at 500 their strokes muddy and counters fill, so they're
// crispest at their native 400 (Regular). Keep every option on a named Regular or
// Medium instance so the type policy has only those two weights.
//
// `tracking` and `features` are the tightened letter-spacing and the stylistic
// sets Inter and DM Sans are tuned with (single-storey a, open digits). The
// other faces take their native metrics: SF Pro with these on top read visibly
// different from the same system font in every other macOS app.
const INTER_TRACKING = '-0.0115em'
const INTER_FEATURES = "'kern' 1, 'liga' 1, 'calt' 1, 'cv02' 1, 'cv03' 1, 'cv04' 1, 'cv11' 1, 'ss01' 1"
export const APP_FONT_FAMILIES: { id: AppFontFamily; label: string; stack: string; weight: number; tracking?: string; features?: string }[] = [
  ...(IS_MAC_OS ? [{ id: 'sf-pro-text' as const, label: 'SF Pro Text', stack: "'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", weight: 400 }] : []),
  { id: 'inter', label: 'Inter', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 500, tracking: INTER_TRACKING, features: INTER_FEATURES },
  { id: 'dm-sans', label: 'DM Sans', stack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 500, tracking: INTER_TRACKING, features: INTER_FEATURES },
  { id: 'system', label: 'System', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 400 },
  { id: 'geist', label: 'Geist Sans', stack: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", weight: 400 },
  { id: 'lora', label: 'Lora', stack: "'Lora', Georgia, 'Times New Roman', serif", weight: 400 },
  { id: 'sf-mono', label: 'SF Mono', stack: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace", weight: 400 },
]

/** The stack the interface font preference renders with: a preset's own stack,
 *  or an installed family name in front of the default preset's stack. */
function interfaceFontStack(fontFamily: FontFamilyPreference): string {
  const preset = APP_FONT_FAMILIES.find((option) => option.id === fontFamily)
  if (preset) return preset.stack
  const fallback = APP_FONT_FAMILIES.find((option) => option.id === DEFAULT_APP_FONT_FAMILY) ?? APP_FONT_FAMILIES[0]
  return customFamilyStack(fontFamily, fallback.stack)
}

function applyFontFamily(fontFamily: FontFamilyPreference): void {
  const preset = APP_FONT_FAMILIES.find((option) => option.id === fontFamily)
  document.documentElement.style.setProperty('--solus-font-family', interfaceFontStack(fontFamily))
  // Each preset uses only its Regular or Medium named instance; an installed
  // family is an unknown quantity, so it takes its native Regular.
  const weight = preset?.weight ?? 400
  document.documentElement.style.setProperty('--solus-font-weight-body', String(weight))
  document.documentElement.style.setProperty('--solus-font-weight-secondary', String(weight))
  document.documentElement.style.setProperty('--solus-font-weight-user-content', String(weight))
  document.documentElement.style.setProperty('--solus-font-tracking', preset?.tracking ?? 'normal')
  document.documentElement.style.setProperty('--solus-font-features', preset?.features ?? 'normal')
}

export const APP_CODE_FONT_FAMILIES: { id: AppCodeFontFamily; label: string; stack: string }[] = [
  { id: 'sf-mono', label: 'SF Mono', stack: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace" },
  { id: 'geist-mono', label: 'Geist Mono', stack: "'Geist Mono', ui-monospace, SFMono-Regular, monospace" },
  { id: 'fira-code', label: 'Fira Code', stack: "'Fira Code', ui-monospace, SFMono-Regular, monospace" },
  { id: 'cascadia-code', label: 'Cascadia Code', stack: "'Cascadia Code', ui-monospace, SFMono-Regular, monospace" },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace" },
  { id: 'system-mono', label: 'System Mono', stack: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace" },
]

export const DOCUMENT_FONT_FAMILIES: { id: DocumentFontFamily; label: string }[] = [
  { id: 'solus', label: 'Solus preset' },
  ...APP_FONT_FAMILIES.map(({ id, label }) => ({ id, label })),
]

const DEFAULT_DOCUMENT_FONT_SIZE = 16

function applyDocumentFontFamily(documentFontFamily: FontFamilyPreference): void {
  // 'solus' is the preset: the interface face for the body, Lora for headings.
  // Any other value, preset or installed name, is one face for both.
  const stack = documentFontFamily === 'solus' ? null : interfaceFontStack(documentFontFamily)
  document.documentElement.style.setProperty(
    '--solus-document-font-family',
    stack ?? 'var(--solus-font-family)',
  )
  document.documentElement.style.setProperty(
    '--solus-document-heading-font-family',
    stack ?? "'Lora', Georgia, 'Times New Roman', serif",
  )
}

function applyDocumentFontSize(size: number): void {
  document.documentElement.style.setProperty(
    '--solus-document-font-scale',
    String(size / DEFAULT_DOCUMENT_FONT_SIZE),
  )
}

/** The prompt box: the interface face by default, or one face chosen for it
 *  alone. `--solus-prompt-font-family` is read by every composer wrapper. */
export const PROMPT_FONT_FAMILIES: { id: PromptFontFamily; label: string }[] = [
  { id: 'interface', label: 'Interface font' },
  ...APP_FONT_FAMILIES.map(({ id, label }) => ({ id, label })),
  ...APP_CODE_FONT_FAMILIES.filter((font) => font.id !== 'sf-mono').map(({ id, label }) => ({ id, label })),
]

/** 13px at the 16px root — one step under the transcript body, so the box you
 *  type in reads a little quieter than the reply. Absolute rather than a
 *  multiple of the interface size, so the two preferences never scale the box
 *  twice. */
const DEFAULT_PROMPT_FONT_SIZE = 13

function applyPromptFontFamily(promptFontFamily: FontFamilyPreference): void {
  const preset =
    APP_FONT_FAMILIES.find((option) => option.id === promptFontFamily) ??
    APP_CODE_FONT_FAMILIES.find((option) => option.id === promptFontFamily)
  document.documentElement.style.setProperty(
    '--solus-prompt-font-family',
    promptFontFamily === 'interface'
      ? 'var(--solus-font-family)'
      : (preset?.stack ?? interfaceFontStack(promptFontFamily)),
  )
}

function applyPromptFontSize(size: number): void {
  // A scale like the code font: `--solus-prompt-font-size` is a rem calc in
  // index.css, so the box follows zoom exactly as every other rung does.
  document.documentElement.style.setProperty('--solus-prompt-font-scale', String(size / DEFAULT_PROMPT_FONT_SIZE))
}

function applyFontSmoothing(enabled: boolean): void {
  // Inherited from the root; `auto` restores the platform default, which macOS
  // renders with heavier stem darkening.
  document.documentElement.style.setProperty('--solus-font-smoothing', enabled ? 'antialiased' : 'auto')
}

const DEFAULT_CODE_FONT_SIZE = 12
const DEFAULT_CODE_FONT_FAMILY: AppCodeFontFamily = 'jetbrains-mono'

function applyCodeFontFamily(codeFontFamily: FontFamilyPreference): void {
  const preset = APP_CODE_FONT_FAMILIES.find((option) => option.id === codeFontFamily)
  const fallback = APP_CODE_FONT_FAMILIES.find((option) => option.id === DEFAULT_CODE_FONT_FAMILY) ?? APP_CODE_FONT_FAMILIES[0]
  document.documentElement.style.setProperty(
    '--solus-code-font-family',
    preset?.stack ?? customFamilyStack(codeFontFamily, fallback.stack),
  )
}

function applyCodeFontSize(size: number): void {
  // Set only the scale multiplier — `--solus-code-font-size` is a rem-based
  // calc() (see index.css), so the code/diff font scales with the screen via the
  // root font-size AND with this user preference. Mirrors applyFontSize. Hard-
  // setting a px value here would freeze the code font and break screen scaling.
  document.documentElement.style.setProperty('--solus-code-font-scale', String(size / DEFAULT_CODE_FONT_SIZE))
}

const SETTINGS_KEY = 'solus-settings'

/** Long enough to swallow a slider drag or a burst of typing, short enough that
 *  a second device sees the change while the user is still looking at it. */
const HOST_PUSH_DEBOUNCE_MS = 400

// ─── The two tiers ───
//
// A setting is one row in one of the two tables below, and nothing else: the
// stored shape, the defaults, the reactive fields, `update`, and the host
// mirror are all read off them.
//
// The promoted tier is a list of host-config keys. The contract owns each key's
// schema and default; this client only names which ones it mirrors and where it
// knows better than the host's platform-neutral default. Host-only controls —
// Solus tools, model routing, rate-limit behavior, operator settings — use
// their own host-scoped stores and must not be seeded from here.
//
// The device tier stays in `localStorage`: zoom and keybindings (a desktop
// global shortcut cannot fire on web), pane widths, panel collapse state, the
// sidebar filter, and the onboarding flag.

const MIRRORED_HOST_KEYS = [
  'themeMode',
  'voiceModeEnabled',
  'autoSendVoiceTranscripts',
  'vadSilenceMs',
  'defaultEditor',
  'fallbackTerminal',
  'activeAgent',
  'defaultPermissionMode',
  'notifications',
  'defaultModels',
  'reviewAgent',
  'reviewModel',
  'reviewReasoning',
  'reviewGuideInstructions',
  'savedLenses',
  'generatePrGuidesOnOpen',
  'reviewWarmingByProject',
  'responseStreamingMode',
  'autoRenameSessions',
  'tasksEnabled',
  'showDiffSummaryAfterTurn',
  'collapseComposerWhenIdle',
  'fontFamily',
  'fontSize',
  'codeFontFamily',
  'codeFontSize',
  'documentFontFamily',
  'documentFontSize',
  'promptFontFamily',
  'promptFontSize',
  'fontSmoothing',
  'extraInstructions',
  'modelInstructions',
  'analyticsEnabled',
  'tabGroupMode',
  'sidebarCompletedRetentionDays',
  'sidebarMotionMs',
  'archivedAutomationRetentionDays',
] as const satisfies readonly HostConfigKey[]

type MirroredHostKey = (typeof MIRRORED_HOST_KEYS)[number]
type MirroredHostConfig = Pick<HostConfig, MirroredHostKey>
const MIRRORED_HOST_KEY_SET: ReadonlySet<string> = new Set(MIRRORED_HOST_KEYS)

function isHostConfigKey(key: string): key is MirroredHostKey {
  return MIRRORED_HOST_KEY_SET.has(key)
}

/** Where this client resolves a better first-run default than the host can:
 *  the host does not know whether it is talking to a Mac or a phone. */
const CLIENT_HOST_DEFAULTS: Partial<MirroredHostConfig> = {
  fontFamily: DEFAULT_APP_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
}

/**
 * Drop unknown binding ids and malformed combos so a stale or hand-edited
 * localStorage blob can't break the dispatcher. Each value must be a combo with
 * a string `code`; the modifier flags, if present, must be booleans.
 */
const keyComboSchema = z.object({
  code: z.string().min(1),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
  meta: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  mod: z.boolean().optional(),
})

const keybindingsSchema = z.record(z.string(), keyComboSchema).transform((bindings) => {
  const valid: Record<string, KeyCombo> = {}
  for (const [id, combo] of Object.entries(bindings)) {
    if (id in KEYBINDINGS) valid[id] = combo
  }
  return valid
})

const projectPanelCollapsedSchema = z.object({
  goal: z.boolean().optional(),
  environment: z.boolean().optional(),
  git: z.boolean().optional(),
  task: z.boolean().optional(),
  subagents: z.boolean().optional(),
  watches: z.boolean().optional(),
  automations: z.boolean().optional(),
}).transform((collapsed) => ({ ...DEFAULT_PROJECT_PANEL_COLLAPSED, ...collapsed }))

const projectLocationSchema = z.object({
  serverId: z.string().min(1),
  directory: z.string().min(1),
})

/** A project directory on one host. A path names a folder on one machine only. */
export type ProjectLocation = z.infer<typeof projectLocationSchema>

interface DeviceField<Value> {
  /** Heals a stored value; a bad one falls back rather than failing the blob. */
  schema: z.ZodType<Value, unknown>
  /** A fresh install. */
  default: Value
  /** A stored blob without the key, when that means something other than a
   *  fresh install. Unset means the fresh default. */
  missing?: Value
}

function deviceField<Value>(
  schema: z.ZodType<Value, unknown>,
  defaultValue: Value,
  missing?: Value,
): DeviceField<Value> {
  return { schema, default: defaultValue, missing }
}

const DEVICE_FIELDS = {
  // Only a first run may seed the screen-derived zoom (see the constructor);
  // a blob from before zoom existed reads as the neutral factor instead.
  zoomFactor: deviceField(z.number().transform(clampZoomFactor).catch(ZOOM_FACTOR_DEFAULT), DEFAULT_ZOOM_FACTOR, ZOOM_FACTOR_DEFAULT),
  // Settings → Appearance shows the per-surface font overrides (prompt,
  // document, smoothing) only when this is on; the two-font view is the
  // default. Device-local: it is how this client's settings page is folded,
  // not a preference the host mirrors.
  typographyAdvanced: deviceField(z.boolean().catch(false), false),
  keybindings: deviceField<Record<string, KeyCombo>>(keybindingsSchema.catch({}), {}),
  projectPanelOpen: deviceField(z.boolean().catch(false), false),
  splitProjectPanelOpen: deviceField(z.boolean().catch(false), false),
  projectPanelWidth: deviceField<number | null>(z.number().positive().nullable().catch(null), null),
  splitProjectPanelWidth: deviceField<number | null>(z.number().positive().nullable().catch(null), null),
  projectPanelCollapsed: deviceField<Record<ProjectPanelSectionId, boolean>>(
    projectPanelCollapsedSchema.catch(DEFAULT_PROJECT_PANEL_COLLAPSED),
    DEFAULT_PROJECT_PANEL_COLLAPSED,
  ),
  splitProjectPanelCollapsed: deviceField<Record<ProjectPanelSectionId, boolean>>(
    projectPanelCollapsedSchema.catch(DEFAULT_PROJECT_PANEL_COLLAPSED),
    DEFAULT_PROJECT_PANEL_COLLAPSED,
  ),
  // The project the task list is scoped to, by `projectKey`. Null is the whole
  // list — the sidebar is flat across every open project either way, so this
  // narrows what is in it rather than changing its shape.
  sidebarProjectFilter: deviceField<string | null>(z.string().nullable().catch(null), null),
  // The project the last session started in, and the host that holds it. A new
  // session opened with nothing on screen to follow starts here. Device-local:
  // a server id only means something to the client that registered it.
  lastProject: deviceField<ProjectLocation | null>(projectLocationSchema.nullable().catch(null), null),
  // First-run onboarding has already been through, or skipped. A client that
  // has never persisted settings is a fresh install, so the absence of the
  // whole blob is what means "show it" — a saved blob without this key belongs
  // to someone who was already working here before onboarding existed, and
  // they do not get ambushed with it.
  onboardingCompleted: deviceField(z.boolean().catch(true), false, true),
}

type DeviceKey = keyof typeof DEVICE_FIELDS
type DeviceFields = { [K in DeviceKey]: (typeof DEVICE_FIELDS)[K]['default'] }
const DEVICE_KEYS: readonly DeviceKey[] = Object.keys(DEVICE_FIELDS).filter(
  (key): key is DeviceKey => Object.hasOwn(DEVICE_FIELDS, key),
)

export type SettingsFields = MirroredHostConfig & DeviceFields
type SettingKey = keyof SettingsFields
const SETTING_KEYS: readonly SettingKey[] = [...MIRRORED_HOST_KEYS, ...DEVICE_KEYS]

/** How a key paints. Run for every key at boot and for each key `update`
 *  changes, so the document always shows the stored value. */
type SettingEffects = { [K in SettingKey]?: (value: SettingsFields[K]) => void }
const SETTING_EFFECTS: SettingEffects = {
  fontFamily: applyFontFamily,
  fontSize: applyFontSize,
  zoomFactor: applyZoomFactor,
  codeFontFamily: applyCodeFontFamily,
  codeFontSize: applyCodeFontSize,
  documentFontFamily: applyDocumentFontFamily,
  documentFontSize: applyDocumentFontSize,
  promptFontFamily: applyPromptFontFamily,
  promptFontSize: applyPromptFontSize,
  fontSmoothing: applyFontSmoothing,
}

/** Bounds a value takes on the way in, so a slider or a typed number cannot
 *  store something the surfaces reading it cannot render. */
type SettingNormalizers = { [K in SettingKey]?: (value: SettingsFields[K]) => SettingsFields[K] }
const SETTING_NORMALIZERS: SettingNormalizers = {
  vadSilenceMs: (value) => Math.max(1000, Math.min(8000, value)),
  fontSize: (value) => Math.max(8, value),
  zoomFactor: clampZoomFactor,
  codeFontSize: (value) => Math.max(8, value),
  documentFontSize: (value) => Math.max(12, value),
  promptFontSize: (value) => Math.max(8, value),
  sidebarCompletedRetentionDays: (value) => Math.max(1, Math.min(365, Math.floor(value))),
  sidebarMotionMs: (value) => Math.max(0, Math.min(MAX_SIDEBAR_MOTION_MS, Math.round(value))),
}

// ─── Loading ───

/** A stored key reads through its own schema, which heals a bad value; an
 *  absent key reads as `missing`. `.optional()` is what tells the two apart —
 *  a `.catch` on its own would turn absence into the schema's fallback. */
function storedField<Value>(schema: z.ZodType<Value, unknown>, missing: Value): z.ZodType<Value, unknown> {
  return schema.optional().transform((value) => (value === undefined ? missing : value))
}

type StoredSettingsFields = { [K in Exclude<SettingKey, 'notifications'>]: z.ZodType<SettingsFields[K], unknown> }

/** Built key by key from the two tables. */
function storedSettingsFields(): StoredSettingsFields {
  const hostEntries = MIRRORED_HOST_KEYS.filter((key) => key !== 'notifications').map((key) => [
    key,
    storedField(HOST_CONFIG_FIELDS[key].patch, CLIENT_HOST_DEFAULTS[key] ?? DEFAULT_HOST_CONFIG[key]),
  ])
  const deviceEntries = DEVICE_KEYS.map((key) => {
    const field = DEVICE_FIELDS[key]
    return [key, storedField(field.schema, field.missing ?? field.default)]
  })
  // SAFETY: every key of both tables contributes one entry, and `SettingKey` is their union.
  return Object.fromEntries([...hostEntries, ...deviceEntries]) as StoredSettingsFields
}

/** The whole object is stored, so a malformed blob heals to the defaults;
 *  a well-formed partial is completed by the merge below. Absent altogether,
 *  the legacy flags below decide. */
const notificationPreferencesSchema = notificationPreferencesPatchSchema
  .transform((patch) => mergeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES, patch))
  .catch(DEFAULT_NOTIFICATION_PREFERENCES)

const storedSettingsSchema = z.object({
  ...storedSettingsFields(),
  notifications: notificationPreferencesSchema.optional(),
})

/** `defaultTerminal` became `fallbackTerminal` when terminal choice turned into a
 * fallback for sessions with no attached terminal. Keep the old pick when the
 * new key has never been written. */
const legacyTerminalSchema = z.object({
  fallbackTerminal: z.undefined().optional(),
  defaultTerminal: z.enum(TERMINAL_APP_IDS),
})

/** `soundEnabled` gated the sound and the system alert together, and
 * `backgroundActivityToasts` gated toasts, before `notifications` replaced them.
 * A blob without the new key keeps the choices the old flags recorded. */
const legacyNotificationFlagsSchema = z.object({
  soundEnabled: z.boolean().optional(),
  backgroundActivityToasts: z.boolean().optional(),
})
type LegacyNotificationFlags = z.infer<typeof legacyNotificationFlagsSchema>

function notificationsFromLegacyFlags(flags: LegacyNotificationFlags): NotificationPreferences {
  const channels: NonNullable<NotificationPreferencesPatch['channels']> = {}
  if (flags.soundEnabled !== undefined) {
    channels.sound = flags.soundEnabled
    channels.system = flags.soundEnabled
  }
  if (flags.backgroundActivityToasts !== undefined) channels.toast = flags.backgroundActivityToasts
  return mergeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES, { channels })
}

function freshSettings(): SettingsFields {
  const hostEntries = MIRRORED_HOST_KEYS.map((key) => [key, CLIENT_HOST_DEFAULTS[key] ?? DEFAULT_HOST_CONFIG[key]])
  const deviceEntries = DEVICE_KEYS.map((key) => [key, DEVICE_FIELDS[key].default])
  // SAFETY: every key of both tables contributes one entry, and `SettingKey` is their union.
  return Object.fromEntries([...hostEntries, ...deviceEntries]) as SettingsFields
}

/** True when this boot found a settings blob. Only a first run may seed the
 *  screen-derived zoom, and it persists the result immediately. */
let hasStoredSettings = false

/** Cloned on the way out: the defaults are shared module constants, and the
 *  `$state` proxy over the result writes through to the object beneath it. */
function loadSettings(): SettingsFields {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const stored: unknown = JSON.parse(raw)
      const parsed = storedSettingsSchema.safeParse(stored)
      if (parsed.success) {
        hasStoredSettings = true
        const legacyTerminal = legacyTerminalSchema.safeParse(stored)
        const legacyFlags = legacyNotificationFlagsSchema.safeParse(stored)
        return structuredClone({
          ...parsed.data,
          fallbackTerminal: legacyTerminal.success ? legacyTerminal.data.defaultTerminal : parsed.data.fallbackTerminal,
          notifications:
            parsed.data.notifications ??
            (legacyFlags.success ? notificationsFromLegacyFlags(legacyFlags.data) : DEFAULT_NOTIFICATION_PREFERENCES),
        })
      }
    }
  } catch {}
  return structuredClone(freshSettings())
}

// ─── The context ───

/**
 * Every setting reads as a property of the context — `settings.themeMode` —
 * through the reactive object beneath, so a `$derived` on one key wakes for
 * that key alone. The properties are defined in the constructor from the key
 * list; the interface merge below is what makes them typed. Writes go through
 * `update`, which is why they are read-only here.
 */
// eslint-disable-next-line typescript/no-unsafe-declaration-merging -- the constructor defines every `SettingKey` before anything reads it
export interface SettingsContext extends Readonly<SettingsFields> {}

export class SettingsContext {
  private values = $state<SettingsFields>(loadSettings())
  // Seeded from the media query so 'system' paints correctly before the main
  // process answers; `setSystemTheme` takes over from there.
  private _systemIsDark = $state(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)

  /** The host that owns the promoted tier, once `hydrateFromHost` has run. */
  private hostConfigServerId: string | null = null
  /** Which promoted keys are waiting to be pushed. Values are read at flush. */
  private readonly pendingHostKeys = new Set<MirroredHostKey>()
  private hostPushTimer: ReturnType<typeof setTimeout> | null = null
  private applyingFromHost = false

  constructor() {
    for (const key of SETTING_KEYS) {
      Object.defineProperty(this, key, { get: () => this.values[key], enumerable: true })
    }

    // Must run before first paint so CSS variables resolve to the saved palette.
    applyTheme(this.isDark)
    for (const key of SETTING_KEYS) this.runEffect(key, this.values[key])

    // Write the seeded blob straight back on a first run so the screen-derived
    // zoom is decided once. Chromium reports `screen.width` in zoomed CSS
    // pixels, so a later boot would read the widened value and undo the seed.
    if (!hasStoredSettings) this.saveSettings()

    // Zoom applies per-webContents but is one user preference. Renderers share
    // this origin's localStorage, so re-apply a change here rather than showing
    // a stale scale until the next boot.
    window.addEventListener('storage', (e) => {
      if (e.key !== SETTINGS_KEY || !e.newValue) return
      try {
        const parsed = z.object({ zoomFactor: z.number() }).safeParse(JSON.parse(e.newValue))
        if (!parsed.success) return
        const next = clampZoomFactor(parsed.data.zoomFactor)
        if (next === this.values.zoomFactor) return
        this.values.zoomFactor = next
        applyZoomFactor(next)
      } catch {}
    })
  }

  get isDark(): boolean {
    return this.values.themeMode === 'dark' || (this.values.themeMode === 'system' && this._systemIsDark)
  }

  get ctx(): SettingsCtx {
    return {
      themeMode: this.themeMode,
      isDark: this.isDark,
      voiceModeEnabled: this.voiceModeEnabled,
      vadSilenceMs: this.vadSilenceMs,
      defaultEditor: this.defaultEditor,
      fallbackTerminal: this.fallbackTerminal,
      activeAgent: this.activeAgent,
      reviewAgent: this.reviewAgent,
      reviewModel: this.reviewModel,
      reviewReasoning: this.reviewReasoning,
      reviewGuideInstructions: this.reviewGuideInstructions,
      reviewWarmingEnabled: false,
      // Legacy RPC field; the receiving host resolves its own policy.
      rateLimitBehavior: 'ask',
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      codeFontFamily: this.codeFontFamily,
      codeFontSize: this.codeFontSize,
      extraInstructions: this.extraInstructions,
      // Plain-object snapshot: modelInstructions is a $state proxy and proxies
      // aren't structured-cloneable, so passing it raw breaks every IPC call
      // that embeds this ctx (e.g. sending a prompt).
      modelInstructions: $state.snapshot(this.modelInstructions),
    }
  }

  ctxForProject(projectPath: string): SettingsCtx {
    return { ...this.ctx, reviewWarmingEnabled: this.reviewWarmingByProject[projectPath] === true }
  }

  isReviewWarmingEnabled(projectPath: string): boolean {
    return this.reviewWarmingByProject[projectPath] === true
  }

  setReviewWarmingEnabled(projectPath: string, enabled: boolean): void {
    if (!projectPath || projectPath === '~') return
    this.values.reviewWarmingByProject[projectPath] = enabled
    this.saveSettings()
    this.scheduleHostPush({ reviewWarmingByProject: this.values.reviewWarmingByProject })
  }

  update(patch: Partial<SettingsFields>): void {
    for (const key of SETTING_KEYS) {
      if (key === 'notifications') continue
      this.adopt(key, patch[key])
    }
    if (patch.notifications !== undefined) this.adoptNotifications(patch.notifications)
    // The theme resolves through the system preference, so it reads the
    // context rather than the value alone.
    if (patch.themeMode !== undefined) applyTheme(this.isDark)
    // Consent is applied on change only; the shell initialises analytics at
    // boot from the stored value. The host learns about it through the
    // host-config push below, which every client makes — the old
    // `setAnalyticsConsent` call was desktop-only, so a user who opted out on
    // web was still counted by the server.
    if (patch.analyticsEnabled !== undefined) setAnalyticsEnabled(patch.analyticsEnabled)
    this.saveSettings()
    // localStorage stays the whole blob — device config plus a mirror of the
    // promoted tier, so a boot paints instantly and an offline client keeps its
    // settings. The host is the authority; this is the write-through.
    this.scheduleHostPush(patch)
  }

  private adopt<K extends Exclude<SettingKey, 'notifications'>>(key: K, value: SettingsFields[K] | undefined): void {
    if (value === undefined) return
    const next = SETTING_NORMALIZERS[key]?.(value) ?? value
    this.values[key] = next
    this.runEffect(key, next)
  }

  private runEffect<K extends SettingKey>(key: K, value: SettingsFields[K]): void {
    SETTING_EFFECTS[key]?.(value)
  }

  /** Written per flag so a `$derived` on one switch does not wake for the others. */
  private adoptNotifications(next: NotificationPreferences): void {
    for (const channel of NOTIFICATION_CHANNELS) this.values.notifications.channels[channel] = next.channels[channel]
    for (const event of NOTIFICATION_EVENTS) this.values.notifications.events[event] = next.events[event]
  }

  setNotificationChannel(channel: NotificationChannel, enabled: boolean): void {
    this.values.notifications.channels[channel] = enabled
    this.saveSettings()
    this.scheduleHostPush({ notifications: this.values.notifications })
  }

  setNotificationEvent(event: NotificationEvent, enabled: boolean): void {
    this.values.notifications.events[event] = enabled
    this.saveSettings()
    this.scheduleHostPush({ notifications: this.values.notifications })
  }

  zoomIn(): void {
    this.setZoomFactor(stepZoomFactor(this.values.zoomFactor, 1))
  }

  zoomOut(): void {
    this.setZoomFactor(stepZoomFactor(this.values.zoomFactor, -1))
  }

  resetZoom(): void {
    this.setZoomFactor(ZOOM_FACTOR_DEFAULT)
  }

  setZoomFactor(factor: number): void {
    this.values.zoomFactor = clampZoomFactor(factor)
    applyZoomFactor(this.values.zoomFactor)
    this.saveSettings()
  }

  // OS-supplied system theme; not persisted.
  setSystemTheme(isDark: boolean): void {
    this._systemIsDark = isDark
    if (this.values.themeMode === 'system') {
      applyTheme(isDark)
    }
  }

  /** The promoted tier, as a plain object: these are `$state` proxies, and a
   *  proxy is not structured-cloneable, so passing one raw fails the RPC call. */
  get hostConfig(): MirroredHostConfig {
    const plain = $state.snapshot(this.values)
    // SAFETY: every `MirroredHostKey` contributes one entry, so the result has exactly those keys.
    return Object.fromEntries(MIRRORED_HOST_KEYS.map((key) => [key, plain[key]])) as MirroredHostConfig
  }

  /**
   * Adopt this host's config, or seed the host from this client.
   *
   * The seed arm exists because the host cannot compute a platform-correct
   * default: it does not know whether the client asking is a Mac
   * (`sf-pro-text`) or a phone (11px font). So the first client to connect
   * writes what it resolved locally, and every client after it adopts that
   * rather than overwriting a choice the user already made elsewhere.
   */
  async hydrateFromHost(serverId: string): Promise<void> {
    this.hostConfigServerId = serverId
    try {
      const api = serverConnections.apiFor(serverId)
      const snapshot = await api.configGet()
      if (snapshot.seeded) this.adoptHostConfig(snapshot.config)
      else await api.configUpdate(this.hostConfig)
    } catch (e) {
      // An unreachable host is not a reason to lose settings: the localStorage
      // copy is a full mirror of the promoted tier, so the client keeps working
      // on what it painted at boot and reconciles on the next connect.
      console.error('configGet failed', e)
    }
  }

  /** Called once at boot. A second window or a second device editing settings
   *  must not leave this one showing a stale panel. */
  listenForHostConfigChanges(): () => void {
    return subscribeAllHosts('config.changed', (serverId, event) => {
      if (serverId !== this.hostConfigServerId) return
      this.adoptHostConfig(event.config)
    })
  }

  private adoptHostConfig(config: HostConfig): void {
    // Guarded so applying the host's snapshot does not echo straight back to
    // the host as a fresh patch.
    this.applyingFromHost = true
    try {
      this.update(config)
    } finally {
      this.applyingFromHost = false
    }
  }

  /**
   * Coalesced because the callers are continuous: dragging a font-size slider
   * or typing in the instructions box would otherwise send one request per
   * keystroke to a host that may be across a network.
   */
  private scheduleHostPush(patch: Partial<SettingsFields>): void {
    // Applying the host's own snapshot must not echo back to it as a patch.
    if (this.applyingFromHost) return
    for (const key of Object.keys(patch)) {
      if (isHostConfigKey(key)) this.pendingHostKeys.add(key)
    }
    if (this.pendingHostKeys.size === 0) return
    if (this.hostPushTimer !== null) clearTimeout(this.hostPushTimer)
    this.hostPushTimer = setTimeout(() => void this.flushHostPush(), HOST_PUSH_DEBOUNCE_MS)
  }

  private async flushHostPush(): Promise<void> {
    this.hostPushTimer = null
    const serverId = this.hostConfigServerId
    const changed = [...this.pendingHostKeys]
    this.pendingHostKeys.clear()
    if (!serverId || changed.length === 0) return
    // Values are read at flush time, so the last one the user landed on wins.
    const config = this.hostConfig
    const patch: Partial<MirroredHostConfig> = {}
    for (const key of changed) Object.assign(patch, { [key]: config[key] })
    try {
      await serverConnections.apiFor(serverId).configUpdate(patch)
    } catch (e) {
      console.error('configUpdate failed', e)
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify($state.snapshot(this.values)))
    } catch {}
  }
}


export const spacing = {
  contentWidth: 960,
  containerRadius: 20,
  containerPadding: 12,
  tabHeight: 32,
  inputMinHeight: 44,
  inputMaxHeight: 160,
  conversationMaxHeight: 380,
  pillRadius: 9999,
  circleSize: 36,
  circleGap: 8,
} as const

export const [getSettingsContext, setSettingsContext] = createAppContext<SettingsContext>('settings')
