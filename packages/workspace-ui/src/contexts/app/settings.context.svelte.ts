/** Unified settings context: theme + editor/terminal/agent + rate-limit + worktree toggle. */

import { z } from 'zod'

import { createAppContext } from './create-app-context'
import { EDITOR_IDS, TERMINAL_APP_IDS, type AgentId, type AppCodeFontFamily, type AppFontFamily, type EditorId, type ReasoningEffort, type SettingsCtx, type TerminalAppId } from '@solus/contracts/types'
import type { KeyCombo } from '../../lib/keybindings/types'
import { KEYBINDINGS } from '../../lib/keybindings/manifest'
import { setAnalyticsEnabled } from '../../lib/analytics'
import { MOBILE_QUERY } from './viewport'
import { runtime } from './runtime.svelte'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { clampZoomFactor, defaultZoomFactorForScreen, stepZoomFactor, ZOOM_FACTOR_DEFAULT } from '@solus/contracts/zoom'
import { DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS } from '../../lib/completed-task-retention'
import {
  DEFAULT_REVIEW_AGENT,
  DEFAULT_REVIEW_MODEL,
  DEFAULT_REVIEW_REASONING,
  TAB_GROUP_MODES,
} from '@solus/contracts/host-config'
import type { HostConfig } from '@solus/contracts/host-config'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { DocumentFontFamily, RateLimitBehavior, TabGroupMode, ThemeMode } from '@solus/contracts/host-config'

// Host-config vocabulary lives in the contract, because the host validates the
// same values. Re-exported so renderer call sites keep one import.
export { TAB_GROUP_MODES } from '@solus/contracts/host-config'
export type {
  DocumentFontFamily,
  RateLimitBehavior,
  TabGroupMode,
  ThemeMode,
} from '@solus/contracts/host-config'

export type ProjectPanelSectionId = 'goal' | 'environment' | 'git' | 'task' | 'automations'
const DEFAULT_PROJECT_PANEL_COLLAPSED = {
  // The section only exists while a goal is set, so it opens on arrival — a
  // collapsed default would hide the thing the user just asked to see.
  goal: false,
  environment: false,
  git: false,
  // The card only exists while the session is bound to a task, so it opens on
  // arrival — the same reasoning as the goal section above.
  task: true,
  automations: true,
} as const satisfies Record<ProjectPanelSectionId, boolean>

export type SettingsFields = {
  themeMode: ThemeMode
  soundEnabled: boolean
  voiceModeEnabled: boolean
  autoSendVoiceTranscripts: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  fallbackTerminal: TerminalAppId | null
  activeAgent: AgentId
  defaultModels: Record<string, string>  // per-agent model for new sessions; missing → that agent's built-in default
  reviewAgent: AgentId
  reviewModel: string
  reviewReasoning: ReasoningEffort
  reviewGuideInstructions: string
  stackedPrsEnabled: boolean
  generatePrGuidesOnOpen: boolean
  reviewWarmingByProject: Record<string, boolean>
  rateLimitBehavior: RateLimitBehavior
  autoRenameSessions: boolean
  showDiffSummaryAfterTurn: boolean
  fontFamily: AppFontFamily
  fontSize: number
  zoomFactor: number
  codeFontFamily: AppCodeFontFamily
  codeFontSize: number
  documentFontFamily: DocumentFontFamily
  documentFontSize: number
  extraInstructions: string
  modelInstructions: Record<string, string>
  keybindings: Record<string, KeyCombo>
  analyticsEnabled: boolean
  projectPanelOpen: boolean
  splitProjectPanelOpen: boolean
  projectPanelWidth: number | null
  splitProjectPanelWidth: number | null
  projectPanelCollapsed: Record<ProjectPanelSectionId, boolean>
  splitProjectPanelCollapsed: Record<ProjectPanelSectionId, boolean>
  tabGroupMode: TabGroupMode
  /** Number of days a done task remains in the session sidebar's Completed shelf. */
  sidebarCompletedRetentionDays: number
  /** The project the task list is scoped to, by `projectKey`. Null is the whole
   *  list — the sidebar is flat across every open project either way, so this
   *  narrows what is in it rather than changing its shape. */
  sidebarProjectFilter: string | null
  /**
   * First-run onboarding has already been through, or skipped. A client that
   * has never persisted settings is a fresh install, so the absence of the whole
   * blob is what means "show it" — a saved blob without this key belongs to
   * someone who was already working here before onboarding existed, and they do
   * not get ambushed with it.
   */
  onboardingCompleted: boolean
}

/** Safari does not paint `theme-color` neat: it lays a translucent white
 *  material over the toolbars, so chrome fed the app's own edge colour renders
 *  several steps lighter than the page it borders — exactly the seam the
 *  theme-color was there to remove. Measured at ~9% white against the dark
 *  edge on iOS Safari. */
const TOOLBAR_MATERIAL_ALPHA = 0.092

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

const BASE_FONT_SIZE = 13
const DEFAULT_FONT_SIZE = globalThis.matchMedia?.(MOBILE_QUERY).matches ? 11 : 13

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

const IS_MAC_OS = /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? '')
const DEFAULT_APP_FONT_FAMILY: AppFontFamily = IS_MAC_OS ? 'sf-pro-text' : 'inter'

// `weight` is the body weight tuned for crispest rendering of each typeface at
// ~13px under grayscale antialiasing (-webkit-font-smoothing: antialiased).
// Grayscale AA thins glyphs, so Inter/DM Sans need the 500 (Medium named
// instance) bump or they look washed out. Grotesque, system and serif faces
// render heavier — at 500 their strokes muddy and counters fill, so they're
// crispest at their native 400 (Regular). Keep every option on a named Regular or
// Medium instance so the type policy has only those two weights.
export const APP_FONT_FAMILIES: { id: AppFontFamily; label: string; stack: string; weight: number }[] = [
  ...(IS_MAC_OS ? [{ id: 'sf-pro-text' as const, label: 'SF Pro Text', stack: "'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", weight: 400 }] : []),
  { id: 'inter', label: 'Inter', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 500 },
  { id: 'dm-sans', label: 'DM Sans', stack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 500 },
  { id: 'system', label: 'System', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 400 },
  { id: 'geist', label: 'Geist Sans', stack: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", weight: 400 },
  { id: 'lora', label: 'Lora', stack: "'Lora', Georgia, 'Times New Roman', serif", weight: 400 },
  { id: 'sf-mono', label: 'SF Mono', stack: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace", weight: 400 },
]

function applyFontFamily(fontFamily: AppFontFamily): void {
  const family = APP_FONT_FAMILIES.find((option) => option.id === fontFamily) ?? APP_FONT_FAMILIES[0]
  document.documentElement.style.setProperty('--solus-font-family', family.stack)
  // Each selectable face uses only its Regular or Medium named instance.
  document.documentElement.style.setProperty('--solus-font-weight-body', String(family.weight))
  document.documentElement.style.setProperty('--solus-font-weight-secondary', String(family.weight))
  document.documentElement.style.setProperty('--solus-font-weight-user-content', String(family.weight))
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

function applyDocumentFontFamily(documentFontFamily: DocumentFontFamily): void {
  const family = APP_FONT_FAMILIES.find((option) => option.id === documentFontFamily)
  document.documentElement.style.setProperty(
    '--solus-document-font-family',
    family?.stack ?? 'var(--solus-font-family)',
  )
  document.documentElement.style.setProperty(
    '--solus-document-heading-font-family',
    family?.stack ?? "'Lora', Georgia, 'Times New Roman', serif",
  )
}

function applyDocumentFontSize(size: number): void {
  document.documentElement.style.setProperty(
    '--solus-document-font-scale',
    String(size / DEFAULT_DOCUMENT_FONT_SIZE),
  )
}

const DEFAULT_CODE_FONT_SIZE = 12

function applyCodeFontFamily(codeFontFamily: AppCodeFontFamily): void {
  const family = APP_CODE_FONT_FAMILIES.find((option) => option.id === codeFontFamily) ?? APP_CODE_FONT_FAMILIES[0]
  document.documentElement.style.setProperty('--solus-code-font-family', family.stack)
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

/** The promoted tier. Typed against `HostConfig`, so adding a key to the
 *  contract without listing it here fails the typecheck rather than silently
 *  leaving that key device-local. */
const HOST_CONFIG_KEY_MAP = {
  themeMode: true, soundEnabled: true, voiceModeEnabled: true, autoSendVoiceTranscripts: true,
  vadSilenceMs: true, defaultEditor: true, fallbackTerminal: true, activeAgent: true,
  defaultModels: true, reviewAgent: true, reviewModel: true, reviewReasoning: true,
  reviewGuideInstructions: true,
  stackedPrsEnabled: true, generatePrGuidesOnOpen: true, reviewWarmingByProject: true,
  rateLimitBehavior: true, autoRenameSessions: true, showDiffSummaryAfterTurn: true,
  fontFamily: true, fontSize: true, codeFontFamily: true, codeFontSize: true,
  documentFontFamily: true, documentFontSize: true, extraInstructions: true,
  modelInstructions: true, analyticsEnabled: true, tabGroupMode: true,
  sidebarCompletedRetentionDays: true,
} satisfies Record<keyof HostConfig, true>

function isHostConfigKey(key: string): key is keyof HostConfig {
  return key in HOST_CONFIG_KEY_MAP
}


const VALID_AGENTS = ['claude-code', 'codex', 'opencode'] as const satisfies readonly AgentId[]
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
  automations: z.boolean().optional(),
}).transform((collapsed) => ({ ...DEFAULT_PROJECT_PANEL_COLLAPSED, ...collapsed }))

const savedSettingsSchema = z.object({
  themeMode: z.enum(['light', 'dark', 'system']).catch('light'),
  soundEnabled: z.boolean().catch(true),
  voiceModeEnabled: z.boolean().catch(false),
  autoSendVoiceTranscripts: z.boolean().catch(false),
  vadSilenceMs: z.number().transform((value) => Math.max(1000, Math.min(8000, value))).catch(1500),
  defaultEditor: z.enum(EDITOR_IDS).nullable().catch(null),
  fallbackTerminal: z.enum(TERMINAL_APP_IDS).nullable().catch(null),
  activeAgent: z.enum(VALID_AGENTS).catch('claude-code'),
  defaultModels: z.record(z.string(), z.string()).catch({}),
  reviewAgent: z.enum(VALID_AGENTS).catch(DEFAULT_REVIEW_AGENT),
  reviewModel: z.string().catch(DEFAULT_REVIEW_MODEL),
  reviewReasoning: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).catch(DEFAULT_REVIEW_REASONING),
  reviewGuideInstructions: z.string().catch(''),
  stackedPrsEnabled: z.boolean().catch(false),
  generatePrGuidesOnOpen: z.boolean().catch(false),
  reviewWarmingByProject: z.record(z.string(), z.boolean()).catch({}),
  rateLimitBehavior: z.enum(['ask', 'queue', 'continue', 'stop']).catch('ask'),
  autoRenameSessions: z.boolean().catch(true),
  showDiffSummaryAfterTurn: z.boolean().catch(true),
  fontFamily: z.enum(['inter', 'dm-sans', 'system', 'geist', 'lora', 'sf-pro-text', 'sf-mono']).catch(DEFAULT_APP_FONT_FAMILY),
  fontSize: z.number().min(8).catch(DEFAULT_FONT_SIZE),
  zoomFactor: z.number().transform(clampZoomFactor).catch(ZOOM_FACTOR_DEFAULT),
  codeFontFamily: z.enum(['sf-mono', 'geist-mono', 'fira-code', 'cascadia-code', 'jetbrains-mono', 'system-mono']).catch('jetbrains-mono'),
  codeFontSize: z.number().min(8).catch(DEFAULT_CODE_FONT_SIZE),
  documentFontFamily: z.enum(['solus', 'inter', 'dm-sans', 'system', 'geist', 'lora', 'sf-pro-text', 'sf-mono']).catch('solus'),
  documentFontSize: z.number().min(12).catch(DEFAULT_DOCUMENT_FONT_SIZE),
  extraInstructions: z.string().catch(''),
  modelInstructions: z.record(z.string(), z.string()).catch({}),
  keybindings: keybindingsSchema.catch({}),
  analyticsEnabled: z.boolean().catch(true),
  projectPanelOpen: z.boolean().catch(false),
  splitProjectPanelOpen: z.boolean().catch(false),
  projectPanelWidth: z.number().positive().nullable().catch(null),
  splitProjectPanelWidth: z.number().positive().nullable().catch(null),
  projectPanelCollapsed: projectPanelCollapsedSchema.catch(DEFAULT_PROJECT_PANEL_COLLAPSED),
  splitProjectPanelCollapsed: projectPanelCollapsedSchema.catch(DEFAULT_PROJECT_PANEL_COLLAPSED),
  tabGroupMode: z.enum(TAB_GROUP_MODES).catch('flat'),
  sidebarCompletedRetentionDays: z.number().int().min(1).max(365).catch(DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS),
  sidebarProjectFilter: z.string().nullable().catch(null),
  onboardingCompleted: z.boolean().catch(true),
})

/** `defaultTerminal` became `fallbackTerminal` when terminal choice turned into a
 * fallback for sessions with no attached terminal. Keep the old pick. */
const legacyTerminalSchema = z.object({ defaultTerminal: z.enum(TERMINAL_APP_IDS) })

/** True when this boot found a settings blob. Only a first run may seed the
 *  screen-derived zoom, and it persists the result immediately. */
let hasStoredSettings = false

function loadSettings(): SettingsFields {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const stored: unknown = JSON.parse(raw)
      const parsed = savedSettingsSchema.safeParse(stored)
      if (parsed.success) {
        hasStoredSettings = true
        if (parsed.data.fallbackTerminal === null) {
          const legacy = legacyTerminalSchema.safeParse(stored)
          if (legacy.success) parsed.data.fallbackTerminal = legacy.data.defaultTerminal
        }
        return parsed.data
      }
    }
  } catch {}
  return {
    themeMode: 'dark',
    soundEnabled: true,
    voiceModeEnabled: false,
    autoSendVoiceTranscripts: false,
    vadSilenceMs: 1500,
    defaultEditor: 'vim',
    fallbackTerminal: 'default-terminal',
    activeAgent: 'claude-code',
    defaultModels: {},
    reviewAgent: DEFAULT_REVIEW_AGENT,
    reviewModel: DEFAULT_REVIEW_MODEL,
    reviewReasoning: DEFAULT_REVIEW_REASONING,
    reviewGuideInstructions: '',
    stackedPrsEnabled: false,
    generatePrGuidesOnOpen: false,
    reviewWarmingByProject: {},
    rateLimitBehavior: 'ask',
    autoRenameSessions: true,
    showDiffSummaryAfterTurn: true,
    fontFamily: DEFAULT_APP_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    zoomFactor: DEFAULT_ZOOM_FACTOR,
    codeFontFamily: 'jetbrains-mono',
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
    documentFontFamily: 'solus',
    documentFontSize: DEFAULT_DOCUMENT_FONT_SIZE,
    extraInstructions: '',
    modelInstructions: {},
    keybindings: {},
    analyticsEnabled: true,
    projectPanelOpen: false,
    splitProjectPanelOpen: false,
    projectPanelWidth: null,
    splitProjectPanelWidth: null,
    projectPanelCollapsed: { ...DEFAULT_PROJECT_PANEL_COLLAPSED },
    splitProjectPanelCollapsed: { ...DEFAULT_PROJECT_PANEL_COLLAPSED },
    tabGroupMode: 'flat',
    sidebarCompletedRetentionDays: DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS,
    sidebarProjectFilter: null,
    onboardingCompleted: false,
  }
}

export class SettingsContext {
  themeMode = $state<ThemeMode>('dark')
  soundEnabled = $state(true)
  voiceModeEnabled = $state(false)
  autoSendVoiceTranscripts = $state(false)
  vadSilenceMs = $state(1500)
  defaultEditor = $state<EditorId | null>(null)
  fallbackTerminal = $state<TerminalAppId | null>(null)
  activeAgent = $state<AgentId>('claude-code')
  defaultModels = $state<Record<string, string>>({})
  reviewAgent = $state<AgentId>(DEFAULT_REVIEW_AGENT)
  reviewModel = $state(DEFAULT_REVIEW_MODEL)
  reviewReasoning = $state<ReasoningEffort>(DEFAULT_REVIEW_REASONING)
  reviewGuideInstructions = $state('')
  stackedPrsEnabled = $state(false)
  generatePrGuidesOnOpen = $state(false)
  reviewWarmingByProject = $state<Record<string, boolean>>({})
  rateLimitBehavior = $state<RateLimitBehavior>('ask')
  autoRenameSessions = $state(true)
  showDiffSummaryAfterTurn = $state(true)
  fontFamily = $state<AppFontFamily>(DEFAULT_APP_FONT_FAMILY)
  fontSize = $state(13)
  zoomFactor = $state(ZOOM_FACTOR_DEFAULT)
  codeFontFamily = $state<AppCodeFontFamily>('jetbrains-mono')
  codeFontSize = $state(DEFAULT_CODE_FONT_SIZE)
  documentFontFamily = $state<DocumentFontFamily>('solus')
  documentFontSize = $state(DEFAULT_DOCUMENT_FONT_SIZE)
  extraInstructions = $state('')
  modelInstructions = $state<Record<string, string>>({})
  keybindings = $state<Record<string, KeyCombo>>({})
  analyticsEnabled = $state(true)
  projectPanelOpen = $state(false)
  splitProjectPanelOpen = $state(false)
  projectPanelWidth = $state<number | null>(null)
  splitProjectPanelWidth = $state<number | null>(null)
  projectPanelCollapsed = $state<Record<ProjectPanelSectionId, boolean>>({ ...DEFAULT_PROJECT_PANEL_COLLAPSED })
  splitProjectPanelCollapsed = $state<Record<ProjectPanelSectionId, boolean>>({ ...DEFAULT_PROJECT_PANEL_COLLAPSED })
  tabGroupMode = $state<TabGroupMode>('flat')
  sidebarCompletedRetentionDays = $state(DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS)
  sidebarProjectFilter = $state<string | null>(null)
  onboardingCompleted = $state(true)
  // Seeded from the media query so 'system' paints correctly before the main
  // process answers; `setSystemTheme` takes over from there.
  private _systemIsDark = $state(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)

  /** The host that owns the promoted tier, once `hydrateFromHost` has run. */
  private hostConfigServerId: string | null = null
  /** Which promoted keys are waiting to be pushed. Values are read at flush. */
  private readonly pendingHostKeys = new Set<keyof HostConfig>()
  private hostPushTimer: ReturnType<typeof setTimeout> | null = null
  private applyingFromHost = false

  constructor() {
    const saved = loadSettings()
    this.themeMode = saved.themeMode
    this.soundEnabled = saved.soundEnabled
    this.voiceModeEnabled = saved.voiceModeEnabled
    this.autoSendVoiceTranscripts = saved.autoSendVoiceTranscripts
    this.vadSilenceMs = saved.vadSilenceMs
    this.defaultEditor = saved.defaultEditor
    this.fallbackTerminal = saved.fallbackTerminal
    this.activeAgent = saved.activeAgent
    this.defaultModels = saved.defaultModels
    this.reviewAgent = saved.reviewAgent
    this.reviewModel = saved.reviewModel
    this.reviewReasoning = saved.reviewReasoning
    this.reviewGuideInstructions = saved.reviewGuideInstructions
    this.stackedPrsEnabled = saved.stackedPrsEnabled
    this.generatePrGuidesOnOpen = saved.generatePrGuidesOnOpen
    this.reviewWarmingByProject = saved.reviewWarmingByProject
    this.rateLimitBehavior = saved.rateLimitBehavior
    this.autoRenameSessions = saved.autoRenameSessions
    this.showDiffSummaryAfterTurn = saved.showDiffSummaryAfterTurn
    this.fontFamily = saved.fontFamily
    this.fontSize = saved.fontSize
    this.zoomFactor = saved.zoomFactor
    this.codeFontFamily = saved.codeFontFamily
    this.codeFontSize = saved.codeFontSize
    this.documentFontFamily = saved.documentFontFamily
    this.documentFontSize = saved.documentFontSize
    this.extraInstructions = saved.extraInstructions
    this.modelInstructions = saved.modelInstructions
    this.keybindings = saved.keybindings
    this.analyticsEnabled = saved.analyticsEnabled
    this.projectPanelOpen = saved.projectPanelOpen
    this.splitProjectPanelOpen = saved.splitProjectPanelOpen
    this.projectPanelWidth = saved.projectPanelWidth
    this.splitProjectPanelWidth = saved.splitProjectPanelWidth
    this.projectPanelCollapsed = saved.projectPanelCollapsed
    this.splitProjectPanelCollapsed = saved.splitProjectPanelCollapsed
    this.tabGroupMode = saved.tabGroupMode
    this.sidebarCompletedRetentionDays = saved.sidebarCompletedRetentionDays
    this.sidebarProjectFilter = saved.sidebarProjectFilter
    this.onboardingCompleted = saved.onboardingCompleted

    // Must run before first paint so CSS variables resolve to the saved palette.
    applyTheme(this.isDark)
    applyFontFamily(saved.fontFamily)
    applyFontSize(saved.fontSize)
    applyZoomFactor(saved.zoomFactor)
    applyCodeFontFamily(saved.codeFontFamily)
    applyCodeFontSize(saved.codeFontSize)
    applyDocumentFontFamily(saved.documentFontFamily)
    applyDocumentFontSize(saved.documentFontSize)

    // Write the seeded blob straight back on a first run so the screen-derived
    // zoom is decided once. Chromium reports `screen.width` in zoomed CSS
    // pixels, so a later boot would read the widened value and undo the seed.
    if (!hasStoredSettings) this.saveSettings()

    // Zoom applies per-webContents but is one user preference. The pill and
    // editor windows share this origin's localStorage, so when the other
    // window changes zoom, re-apply here rather than showing a stale scale
    // until the next boot.
    window.addEventListener('storage', (e) => {
      if (e.key !== SETTINGS_KEY || !e.newValue) return
      try {
        const parsed = z.object({ zoomFactor: z.number() }).safeParse(JSON.parse(e.newValue))
        if (!parsed.success) return
        const next = clampZoomFactor(parsed.data.zoomFactor)
        if (next === this.zoomFactor) return
        this.zoomFactor = next
        applyZoomFactor(next)
      } catch {}
    })
  }

  get isDark(): boolean {
    return this.themeMode === 'dark' || (this.themeMode === 'system' && this._systemIsDark)
  }

  get ctx(): SettingsCtx {
    return {
      themeMode: this.themeMode,
      isDark: this.isDark,
      soundEnabled: this.soundEnabled,
      voiceModeEnabled: this.voiceModeEnabled,
      vadSilenceMs: this.vadSilenceMs,
      defaultEditor: this.defaultEditor,
      fallbackTerminal: this.fallbackTerminal,
      activeAgent: this.activeAgent,
      reviewAgent: this.reviewAgent,
      reviewModel: this.reviewModel,
      reviewReasoning: this.reviewReasoning,
      reviewGuideInstructions: this.reviewGuideInstructions,
      stackedPrsEnabled: this.stackedPrsEnabled,
      reviewWarmingEnabled: false,
      rateLimitBehavior: this.rateLimitBehavior,
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
    this.reviewWarmingByProject[projectPath] = enabled
    this.saveSettings()
    this.scheduleHostPush({ reviewWarmingByProject: this.reviewWarmingByProject })
  }

  update(patch: Partial<SettingsFields>): void {
    if (patch.themeMode !== undefined) {
      this.themeMode = patch.themeMode
      const resolved = patch.themeMode === 'system' ? this._systemIsDark : patch.themeMode === 'dark'
      applyTheme(resolved)
    }
    if (patch.soundEnabled !== undefined) this.soundEnabled = patch.soundEnabled
    if (patch.voiceModeEnabled !== undefined) this.voiceModeEnabled = patch.voiceModeEnabled
    if (patch.autoSendVoiceTranscripts !== undefined) this.autoSendVoiceTranscripts = patch.autoSendVoiceTranscripts
    if (patch.vadSilenceMs !== undefined) this.vadSilenceMs = Math.max(1000, Math.min(8000, patch.vadSilenceMs))
    if (patch.defaultEditor !== undefined) this.defaultEditor = patch.defaultEditor
    if (patch.fallbackTerminal !== undefined) this.fallbackTerminal = patch.fallbackTerminal
    if (patch.activeAgent !== undefined) this.activeAgent = patch.activeAgent
    if (patch.defaultModels !== undefined) this.defaultModels = patch.defaultModels
    if (patch.reviewAgent !== undefined) this.reviewAgent = patch.reviewAgent
    if (patch.reviewModel !== undefined) this.reviewModel = patch.reviewModel
    if (patch.reviewReasoning !== undefined) this.reviewReasoning = patch.reviewReasoning
    if (patch.reviewGuideInstructions !== undefined) this.reviewGuideInstructions = patch.reviewGuideInstructions
    if (patch.stackedPrsEnabled !== undefined) this.stackedPrsEnabled = patch.stackedPrsEnabled
    if (patch.generatePrGuidesOnOpen !== undefined) this.generatePrGuidesOnOpen = patch.generatePrGuidesOnOpen
    if (patch.reviewWarmingByProject !== undefined) this.reviewWarmingByProject = patch.reviewWarmingByProject
    if (patch.rateLimitBehavior !== undefined) this.rateLimitBehavior = patch.rateLimitBehavior
    if (patch.autoRenameSessions !== undefined) this.autoRenameSessions = patch.autoRenameSessions
    if (patch.showDiffSummaryAfterTurn !== undefined)
      this.showDiffSummaryAfterTurn = patch.showDiffSummaryAfterTurn
    if (patch.fontFamily !== undefined) {
      this.fontFamily = patch.fontFamily
      applyFontFamily(this.fontFamily)
    }
    if (patch.fontSize !== undefined) {
      this.fontSize = Math.max(8, patch.fontSize)
      applyFontSize(this.fontSize)
    }
    if (patch.zoomFactor !== undefined) {
      this.zoomFactor = clampZoomFactor(patch.zoomFactor)
      applyZoomFactor(this.zoomFactor)
    }
    if (patch.codeFontFamily !== undefined) {
      this.codeFontFamily = patch.codeFontFamily
      applyCodeFontFamily(this.codeFontFamily)
    }
    if (patch.codeFontSize !== undefined) {
      this.codeFontSize = Math.max(8, patch.codeFontSize)
      applyCodeFontSize(this.codeFontSize)
    }
    if (patch.documentFontFamily !== undefined) {
      this.documentFontFamily = patch.documentFontFamily
      applyDocumentFontFamily(this.documentFontFamily)
    }
    if (patch.documentFontSize !== undefined) {
      this.documentFontSize = Math.max(12, patch.documentFontSize)
      applyDocumentFontSize(this.documentFontSize)
    }
    if (patch.extraInstructions !== undefined) this.extraInstructions = patch.extraInstructions
    if (patch.modelInstructions !== undefined) this.modelInstructions = patch.modelInstructions
    if (patch.keybindings !== undefined) this.keybindings = patch.keybindings
    if (patch.analyticsEnabled !== undefined) {
      this.analyticsEnabled = patch.analyticsEnabled
      setAnalyticsEnabled(patch.analyticsEnabled)
      // The host learns about consent through the host-config push below, which
      // every client makes. The old `setAnalyticsConsent` call was desktop-only,
      // so a user who opted out on web was still counted by the server.
    }
    if (patch.projectPanelOpen !== undefined) this.projectPanelOpen = patch.projectPanelOpen
    if (patch.splitProjectPanelOpen !== undefined)
      this.splitProjectPanelOpen = patch.splitProjectPanelOpen
    if (patch.projectPanelWidth !== undefined)
      this.projectPanelWidth = patch.projectPanelWidth
    if (patch.splitProjectPanelWidth !== undefined)
      this.splitProjectPanelWidth = patch.splitProjectPanelWidth
    if (patch.projectPanelCollapsed !== undefined) this.projectPanelCollapsed = patch.projectPanelCollapsed
    if (patch.splitProjectPanelCollapsed !== undefined)
      this.splitProjectPanelCollapsed = patch.splitProjectPanelCollapsed
    if (patch.tabGroupMode !== undefined) this.tabGroupMode = patch.tabGroupMode
    if (patch.sidebarCompletedRetentionDays !== undefined)
      this.sidebarCompletedRetentionDays = Math.max(1, Math.min(365, Math.floor(patch.sidebarCompletedRetentionDays)))
    if (patch.sidebarProjectFilter !== undefined)
      this.sidebarProjectFilter = patch.sidebarProjectFilter
    if (patch.onboardingCompleted !== undefined) this.onboardingCompleted = patch.onboardingCompleted
    this.saveSettings()
    // localStorage stays the whole blob — device config plus a mirror of the
    // promoted tier, so a boot paints instantly and an offline client keeps its
    // settings. The host is the authority; this is the write-through.
    this.scheduleHostPush(patch)
  }

  // OS-supplied system theme; not persisted.
  zoomIn(): void {
    this.setZoomFactor(stepZoomFactor(this.zoomFactor, 1))
  }

  zoomOut(): void {
    this.setZoomFactor(stepZoomFactor(this.zoomFactor, -1))
  }

  resetZoom(): void {
    this.setZoomFactor(ZOOM_FACTOR_DEFAULT)
  }

  setZoomFactor(factor: number): void {
    this.zoomFactor = clampZoomFactor(factor)
    applyZoomFactor(this.zoomFactor)
    this.saveSettings()
  }

  setSystemTheme(isDark: boolean): void {
    this._systemIsDark = isDark
    if (this.themeMode === 'system') {
      applyTheme(isDark)
    }
  }

  /**
   * The promoted tier. Everything not listed here is device config and stays in
   * `localStorage`: zoom and keybindings (a desktop global shortcut cannot fire
   * on web), pane widths, panel collapse state, the sidebar filter, and the
   * onboarding flag.
   */
  get hostConfig(): HostConfig {
    return {
      themeMode: this.themeMode,
      soundEnabled: this.soundEnabled,
      voiceModeEnabled: this.voiceModeEnabled,
      autoSendVoiceTranscripts: this.autoSendVoiceTranscripts,
      vadSilenceMs: this.vadSilenceMs,
      defaultEditor: this.defaultEditor,
      fallbackTerminal: this.fallbackTerminal,
      activeAgent: this.activeAgent,
      reviewAgent: this.reviewAgent,
      reviewModel: this.reviewModel,
      reviewReasoning: this.reviewReasoning,
      reviewGuideInstructions: this.reviewGuideInstructions,
      stackedPrsEnabled: this.stackedPrsEnabled,
      generatePrGuidesOnOpen: this.generatePrGuidesOnOpen,
      rateLimitBehavior: this.rateLimitBehavior,
      autoRenameSessions: this.autoRenameSessions,
      showDiffSummaryAfterTurn: this.showDiffSummaryAfterTurn,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      codeFontFamily: this.codeFontFamily,
      codeFontSize: this.codeFontSize,
      documentFontFamily: this.documentFontFamily,
      documentFontSize: this.documentFontSize,
      extraInstructions: this.extraInstructions,
      analyticsEnabled: this.analyticsEnabled,
      tabGroupMode: this.tabGroupMode,
      sidebarCompletedRetentionDays: this.sidebarCompletedRetentionDays,
      // Plain-object snapshots: these are `$state` proxies, and a proxy is not
      // structured-cloneable, so passing one raw fails the RPC call.
      defaultModels: $state.snapshot(this.defaultModels),
      modelInstructions: $state.snapshot(this.modelInstructions),
      reviewWarmingByProject: $state.snapshot(this.reviewWarmingByProject),
    }
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
    const patch: Partial<HostConfig> = {}
    for (const key of changed) Object.assign(patch, { [key]: config[key] })
    try {
      await serverConnections.apiFor(serverId).configUpdate(patch)
    } catch (e) {
      console.error('configUpdate failed', e)
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        themeMode: this.themeMode,
        soundEnabled: this.soundEnabled,
        voiceModeEnabled: this.voiceModeEnabled,
        autoSendVoiceTranscripts: this.autoSendVoiceTranscripts,
        vadSilenceMs: this.vadSilenceMs,
        defaultEditor: this.defaultEditor,
        fallbackTerminal: this.fallbackTerminal,
        activeAgent: this.activeAgent,
        defaultModels: this.defaultModels,
        reviewAgent: this.reviewAgent,
        reviewModel: this.reviewModel,
        reviewReasoning: this.reviewReasoning,
        reviewGuideInstructions: this.reviewGuideInstructions,
        stackedPrsEnabled: this.stackedPrsEnabled,
        generatePrGuidesOnOpen: this.generatePrGuidesOnOpen,
        reviewWarmingByProject: this.reviewWarmingByProject,
        rateLimitBehavior: this.rateLimitBehavior,
        autoRenameSessions: this.autoRenameSessions,
        showDiffSummaryAfterTurn: this.showDiffSummaryAfterTurn,
        fontFamily: this.fontFamily,
        fontSize: this.fontSize,
        zoomFactor: this.zoomFactor,
        codeFontFamily: this.codeFontFamily,
        codeFontSize: this.codeFontSize,
        documentFontFamily: this.documentFontFamily,
        documentFontSize: this.documentFontSize,
        extraInstructions: this.extraInstructions,
        modelInstructions: this.modelInstructions,
        keybindings: this.keybindings,
        analyticsEnabled: this.analyticsEnabled,
        projectPanelOpen: this.projectPanelOpen,
        splitProjectPanelOpen: this.splitProjectPanelOpen,
        projectPanelWidth: this.projectPanelWidth,
        splitProjectPanelWidth: this.splitProjectPanelWidth,
        projectPanelCollapsed: this.projectPanelCollapsed,
        splitProjectPanelCollapsed: this.splitProjectPanelCollapsed,
        tabGroupMode: this.tabGroupMode,
        sidebarCompletedRetentionDays: this.sidebarCompletedRetentionDays,
        sidebarProjectFilter: this.sidebarProjectFilter,
        onboardingCompleted: this.onboardingCompleted,
      }))
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
