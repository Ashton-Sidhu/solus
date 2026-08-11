/** Unified settings context: theme + editor/terminal/agent + rate-limit + worktree toggle. */

import { createAppContext } from './create-app-context'
import type { AgentId, AppCodeFontFamily, AppFontFamily, EditorId, ReasoningEffort, SettingsCtx, TerminalAppId } from '../../../shared/types'
import { REASONING_EFFORT_LABELS } from '../../../shared/types'
import type { KeyCombo } from '../../lib/keybindings/types'
import { KEYBINDINGS } from '../../lib/keybindings/manifest'
import { setAnalyticsEnabled } from '../../lib/analytics'
import { MOBILE_QUERY } from './runtime.svelte'
import { localApi } from '@client-core/local-api'
import { serverConnections } from '@client-core/server-connections'
import { clampZoomFactor, stepZoomFactor, ZOOM_FACTOR_DEFAULT } from '../../../shared/zoom'

export type ThemeMode = 'system' | 'light' | 'dark'

export type RateLimitBehavior = 'ask' | 'queue' | 'continue' | 'stop'
export type ProjectPanelSectionId = 'goal' | 'environment' | 'git' | 'task' | 'automations'
const DEFAULT_PROJECT_PANEL_COLLAPSED: Record<ProjectPanelSectionId, boolean> = {
  // The section only exists while a goal is set, so it opens on arrival — a
  // collapsed default would hide the thing the user just asked to see.
  goal: false,
  environment: false,
  git: false,
  // The card only exists while the session is bound to a task, so it opens on
  // arrival — the same reasoning as the goal section above.
  task: false,
  automations: true,
}

export const TAB_GROUP_MODES = ['flat', 'status', 'unread'] as const
export type TabGroupMode = (typeof TAB_GROUP_MODES)[number]

/** Two views over the same task list: `flat` sorts across every project on
 *  state, `grouped` sorts inside project headings. */
export const SIDEBAR_VIEW_MODES = ['flat', 'grouped'] as const
export type SidebarViewMode = (typeof SIDEBAR_VIEW_MODES)[number]

export type SettingsFields = {
  themeMode: ThemeMode
  soundEnabled: boolean
  voiceModeEnabled: boolean
  autoSendVoiceTranscripts: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  defaultTerminal: TerminalAppId | null
  activeAgent: AgentId
  defaultModels: Record<string, string>  // per-agent model for new sessions; missing → that agent's built-in default
  reviewAgent: AgentId | null     // review companion backend; null → use activeAgent
  reviewModel: string | null      // review companion model; null → backend default
  reviewReasoning: ReasoningEffort | null  // review companion reasoning effort; null → model default
  stackedPrsEnabled: boolean
  generatePrGuidesOnOpen: boolean
  reviewWarmingByProject: Record<string, boolean>
  rateLimitBehavior: RateLimitBehavior
  worktreeEnabled: boolean
  autoRenameSessions: boolean
  showDiffSummaryAfterTurn: boolean
  fontFamily: AppFontFamily
  fontSize: number
  zoomFactor: number
  codeFontFamily: AppCodeFontFamily
  codeFontSize: number
  extraInstructions: string
  modelInstructions: Record<string, string>
  keybindings: Record<string, KeyCombo>
  analyticsEnabled: boolean
  projectPanelOpen: boolean
  splitProjectPanelOpen: boolean
  projectPanelCollapsed: Record<ProjectPanelSectionId, boolean>
  splitProjectPanelCollapsed: Record<ProjectPanelSectionId, boolean>
  tabGroupMode: TabGroupMode
  sidebarViewMode: SidebarViewMode
  /**
   * First-run onboarding has already been through, or skipped. A client that
   * has never persisted settings is a fresh install, so the absence of the whole
   * blob is what means "show it" — a saved blob without this key belongs to
   * someone who was already working here before onboarding existed, and they do
   * not get ambushed with it.
   */
  onboardingCompleted: boolean
}

function applyTheme(isDark: boolean): void {
  const edgeColor = isDark ? '#1c1b18' : '#f5f3ed'
  const isWebShell = document.documentElement.classList.contains('solus-web')
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.classList.toggle('light', !isDark)
  document.documentElement.style.setProperty('color-scheme', isDark ? 'dark' : 'light')
  if (isWebShell) {
    document.documentElement.style.setProperty('background-color', edgeColor)
    document.body?.style.setProperty('background-color', edgeColor)
  }

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = edgeColor
    meta.removeAttribute('media')
  }

  document
    .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', isDark ? 'black-translucent' : 'default')
}

const BASE_FONT_SIZE = 13
const DEFAULT_FONT_SIZE = typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches ? 11 : 13

function applyFontSize(size: number): void {
  document.documentElement.style.setProperty('--solus-font-scale', String(size / BASE_FONT_SIZE))
}

/** Desktop-only: the web client leans on native browser zoom instead, so the
 *  bridge method is absent there and this is a no-op. */
function applyZoomFactor(factor: number): void {
  localApi.setZoomFactor?.(factor)
}

const IS_MAC_OS = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)
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

const VALID_EDITORS: EditorId[] = ['vscode', 'vim', 'nvim', 'helix']
const VALID_TERMINALS: TerminalAppId[] = ['default-terminal', 'ghostty']
const VALID_AGENTS: AgentId[] = ['claude-code', 'codex', 'opencode']
const VALID_FONT_FAMILIES = APP_FONT_FAMILIES.map((option) => option.id)
const VALID_CODE_FONT_FAMILIES = APP_CODE_FONT_FAMILIES.map((option) => option.id)
/**
 * Drop unknown binding ids and malformed combos so a stale or hand-edited
 * localStorage blob can't break the dispatcher. Each value must be a combo with
 * a string `code`; the modifier flags, if present, must be booleans.
 */
function sanitizeKeybindings(value: unknown): Record<string, KeyCombo> {
  const out: Record<string, KeyCombo> = {}
  if (!value || typeof value !== 'object') return out
  const MOD_KEYS = ['alt', 'shift', 'meta', 'ctrl', 'mod'] as const
  for (const [id, raw] of Object.entries(value)) {
    if (!(id in KEYBINDINGS)) continue
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { code?: unknown; alt?: unknown; shift?: unknown; meta?: unknown; ctrl?: unknown; mod?: unknown }
    if (typeof r.code !== 'string' || !r.code) continue
    if (MOD_KEYS.some((k) => Reflect.get(r, k) !== undefined && typeof Reflect.get(r, k) !== 'boolean')) continue
    const combo: KeyCombo = { code: r.code }
    for (const k of MOD_KEYS) if (Reflect.get(r, k) === true) combo[k] = true
    out[id] = combo
  }
  return out
}

/**
 * Drop non-string values so a hand-edited/stale blob can't break dispatch.
 */
function loadStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object') return out
  for (const [id, text] of Object.entries(value)) {
    if (typeof text === 'string') out[id] = text
  }
  return out
}

function loadBooleanRecord(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled === 'boolean') out[key] = enabled
  }
  return out
}

function loadProjectPanelCollapsed(value: unknown): Record<ProjectPanelSectionId, boolean> {
  const collapsed = { ...DEFAULT_PROJECT_PANEL_COLLAPSED }
  if (!value || typeof value !== 'object') return collapsed
  for (const id of Object.keys(DEFAULT_PROJECT_PANEL_COLLAPSED) as ProjectPanelSectionId[]) {
    const next = Reflect.get(value, id)
    if (typeof next === 'boolean') collapsed[id] = next
  }
  return collapsed
}

function loadSettings(): SettingsFields {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        themeMode: (['light', 'dark', 'system'].includes(parsed.themeMode) ? parsed.themeMode : 'light') as ThemeMode,
        soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : true,
        voiceModeEnabled: typeof parsed.voiceModeEnabled === 'boolean' ? parsed.voiceModeEnabled : false,
        autoSendVoiceTranscripts: typeof parsed.autoSendVoiceTranscripts === 'boolean' ? parsed.autoSendVoiceTranscripts : false,
        vadSilenceMs: typeof parsed.vadSilenceMs === 'number' ? Math.max(1000, Math.min(8000, parsed.vadSilenceMs)) : 1500,
        defaultEditor: VALID_EDITORS.includes(parsed.defaultEditor) ? parsed.defaultEditor : null,
        defaultTerminal: VALID_TERMINALS.includes(parsed.defaultTerminal) ? parsed.defaultTerminal : null,
        activeAgent: VALID_AGENTS.includes(parsed.activeAgent) ? parsed.activeAgent : 'claude-code',
        defaultModels: loadStringRecord(parsed.defaultModels),
        reviewAgent: VALID_AGENTS.includes(parsed.reviewAgent) ? parsed.reviewAgent : null,
        reviewModel: typeof parsed.reviewModel === 'string' ? parsed.reviewModel : null,
        reviewReasoning: parsed.reviewReasoning in REASONING_EFFORT_LABELS ? parsed.reviewReasoning : null,
        stackedPrsEnabled: typeof parsed.stackedPrsEnabled === 'boolean' ? parsed.stackedPrsEnabled : false,
        generatePrGuidesOnOpen: typeof parsed.generatePrGuidesOnOpen === 'boolean' ? parsed.generatePrGuidesOnOpen : false,
        reviewWarmingByProject: loadBooleanRecord(parsed.reviewWarmingByProject),
        rateLimitBehavior: (['ask', 'queue', 'continue', 'stop'].includes(parsed.rateLimitBehavior) ? parsed.rateLimitBehavior : 'ask') as RateLimitBehavior,
        worktreeEnabled: typeof parsed.worktreeEnabled === 'boolean' ? parsed.worktreeEnabled : false,
        autoRenameSessions: typeof parsed.autoRenameSessions === 'boolean' ? parsed.autoRenameSessions : true,
        showDiffSummaryAfterTurn: typeof parsed.showDiffSummaryAfterTurn === 'boolean' ? parsed.showDiffSummaryAfterTurn : true,
        fontFamily: VALID_FONT_FAMILIES.includes(parsed.fontFamily) ? parsed.fontFamily : DEFAULT_APP_FONT_FAMILY,
        fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= 8 ? parsed.fontSize : DEFAULT_FONT_SIZE,
        zoomFactor: typeof parsed.zoomFactor === 'number' ? clampZoomFactor(parsed.zoomFactor) : ZOOM_FACTOR_DEFAULT,
        codeFontFamily: VALID_CODE_FONT_FAMILIES.includes(parsed.codeFontFamily) ? parsed.codeFontFamily : 'jetbrains-mono',
        codeFontSize: typeof parsed.codeFontSize === 'number' && parsed.codeFontSize >= 8 ? parsed.codeFontSize : DEFAULT_CODE_FONT_SIZE,
        extraInstructions: typeof parsed.extraInstructions === 'string' ? parsed.extraInstructions : '',
        modelInstructions: loadStringRecord(parsed.modelInstructions),
        keybindings: sanitizeKeybindings(parsed.keybindings),
        analyticsEnabled: typeof parsed.analyticsEnabled === 'boolean' ? parsed.analyticsEnabled : true,
        projectPanelOpen: typeof parsed.projectPanelOpen === 'boolean' ? parsed.projectPanelOpen : false,
        splitProjectPanelOpen:
          typeof parsed.splitProjectPanelOpen === 'boolean' ? parsed.splitProjectPanelOpen : false,
        projectPanelCollapsed: loadProjectPanelCollapsed(parsed.projectPanelCollapsed),
        splitProjectPanelCollapsed: loadProjectPanelCollapsed(parsed.splitProjectPanelCollapsed),
        tabGroupMode: ((TAB_GROUP_MODES as readonly string[]).includes(parsed.tabGroupMode) ? parsed.tabGroupMode : 'flat') as TabGroupMode,
        sidebarViewMode: ((SIDEBAR_VIEW_MODES as readonly string[]).includes(parsed.sidebarViewMode) ? parsed.sidebarViewMode : 'flat') as SidebarViewMode,
        onboardingCompleted: typeof parsed.onboardingCompleted === 'boolean' ? parsed.onboardingCompleted : true,
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
    defaultTerminal: 'default-terminal',
    activeAgent: 'claude-code',
    defaultModels: {},
    reviewAgent: null,
    reviewModel: null,
    reviewReasoning: null,
    stackedPrsEnabled: false,
    generatePrGuidesOnOpen: false,
    reviewWarmingByProject: {},
    rateLimitBehavior: 'ask',
    worktreeEnabled: false,
    autoRenameSessions: true,
    showDiffSummaryAfterTurn: true,
    fontFamily: DEFAULT_APP_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    zoomFactor: ZOOM_FACTOR_DEFAULT,
    codeFontFamily: 'jetbrains-mono',
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
    extraInstructions: '',
    modelInstructions: {},
    keybindings: {},
    analyticsEnabled: true,
    projectPanelOpen: false,
    splitProjectPanelOpen: false,
    projectPanelCollapsed: { ...DEFAULT_PROJECT_PANEL_COLLAPSED },
    splitProjectPanelCollapsed: { ...DEFAULT_PROJECT_PANEL_COLLAPSED },
    tabGroupMode: 'flat',
    sidebarViewMode: 'flat',
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
  defaultTerminal = $state<TerminalAppId | null>(null)
  activeAgent = $state<AgentId>('claude-code')
  defaultModels = $state<Record<string, string>>({})
  reviewAgent = $state<AgentId | null>(null)
  reviewModel = $state<string | null>(null)
  reviewReasoning = $state<ReasoningEffort | null>(null)
  stackedPrsEnabled = $state(false)
  generatePrGuidesOnOpen = $state(false)
  reviewWarmingByProject = $state<Record<string, boolean>>({})
  rateLimitBehavior = $state<RateLimitBehavior>('ask')
  worktreeEnabled = $state(false)
  autoRenameSessions = $state(true)
  showDiffSummaryAfterTurn = $state(true)
  fontFamily = $state<AppFontFamily>(DEFAULT_APP_FONT_FAMILY)
  fontSize = $state(13)
  zoomFactor = $state(ZOOM_FACTOR_DEFAULT)
  codeFontFamily = $state<AppCodeFontFamily>('jetbrains-mono')
  codeFontSize = $state(DEFAULT_CODE_FONT_SIZE)
  extraInstructions = $state('')
  modelInstructions = $state<Record<string, string>>({})
  keybindings = $state<Record<string, KeyCombo>>({})
  analyticsEnabled = $state(true)
  projectPanelOpen = $state(false)
  splitProjectPanelOpen = $state(false)
  projectPanelCollapsed = $state<Record<ProjectPanelSectionId, boolean>>({ ...DEFAULT_PROJECT_PANEL_COLLAPSED })
  splitProjectPanelCollapsed = $state<Record<ProjectPanelSectionId, boolean>>({ ...DEFAULT_PROJECT_PANEL_COLLAPSED })
  tabGroupMode = $state<TabGroupMode>('flat')
  sidebarViewMode = $state<SidebarViewMode>('flat')
  onboardingCompleted = $state(true)
  // Seeded from the media query so 'system' paints correctly before the main
  // process answers; `setSystemTheme` takes over from there.
  private _systemIsDark = $state(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)

  constructor() {
    const saved = loadSettings()
    this.themeMode = saved.themeMode
    this.soundEnabled = saved.soundEnabled
    this.voiceModeEnabled = saved.voiceModeEnabled
    this.autoSendVoiceTranscripts = saved.autoSendVoiceTranscripts
    this.vadSilenceMs = saved.vadSilenceMs
    this.defaultEditor = saved.defaultEditor
    this.defaultTerminal = saved.defaultTerminal
    this.activeAgent = saved.activeAgent
    this.defaultModels = saved.defaultModels
    this.reviewAgent = saved.reviewAgent
    this.reviewModel = saved.reviewModel
    this.reviewReasoning = saved.reviewReasoning
    this.stackedPrsEnabled = saved.stackedPrsEnabled
    this.generatePrGuidesOnOpen = saved.generatePrGuidesOnOpen
    this.reviewWarmingByProject = saved.reviewWarmingByProject
    this.rateLimitBehavior = saved.rateLimitBehavior
    this.worktreeEnabled = saved.worktreeEnabled
    this.autoRenameSessions = saved.autoRenameSessions
    this.showDiffSummaryAfterTurn = saved.showDiffSummaryAfterTurn
    this.fontFamily = saved.fontFamily
    this.fontSize = saved.fontSize
    this.zoomFactor = saved.zoomFactor
    this.codeFontFamily = saved.codeFontFamily
    this.codeFontSize = saved.codeFontSize
    this.extraInstructions = saved.extraInstructions
    this.modelInstructions = saved.modelInstructions
    this.keybindings = saved.keybindings
    this.analyticsEnabled = saved.analyticsEnabled
    this.projectPanelOpen = saved.projectPanelOpen
    this.splitProjectPanelOpen = saved.splitProjectPanelOpen
    this.projectPanelCollapsed = saved.projectPanelCollapsed
    this.splitProjectPanelCollapsed = saved.splitProjectPanelCollapsed
    this.tabGroupMode = saved.tabGroupMode
    this.sidebarViewMode = saved.sidebarViewMode
    this.onboardingCompleted = saved.onboardingCompleted

    // Must run before first paint so CSS variables resolve to the saved palette.
    applyTheme(this.isDark)
    applyFontFamily(saved.fontFamily)
    applyFontSize(saved.fontSize)
    applyZoomFactor(saved.zoomFactor)
    applyCodeFontFamily(saved.codeFontFamily)
    applyCodeFontSize(saved.codeFontSize)

    // Zoom applies per-webContents but is one user preference. The pill and
    // editor windows share this origin's localStorage, so when the other
    // window changes zoom, re-apply here rather than showing a stale scale
    // until the next boot.
    window.addEventListener('storage', (e) => {
      if (e.key !== SETTINGS_KEY || !e.newValue) return
      try {
        const parsed = JSON.parse(e.newValue)
        if (typeof parsed.zoomFactor !== 'number') return
        const next = clampZoomFactor(parsed.zoomFactor)
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
      defaultTerminal: this.defaultTerminal,
      activeAgent: this.activeAgent,
      reviewAgent: this.reviewAgent,
      reviewModel: this.reviewModel,
      reviewReasoning: this.reviewReasoning,
      stackedPrsEnabled: this.stackedPrsEnabled,
      reviewWarmingEnabled: false,
      worktreeEnabled: this.worktreeEnabled,
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
    if (patch.defaultTerminal !== undefined) this.defaultTerminal = patch.defaultTerminal
    if (patch.activeAgent !== undefined) this.activeAgent = patch.activeAgent
    if (patch.defaultModels !== undefined) this.defaultModels = patch.defaultModels
    if (patch.reviewAgent !== undefined) this.reviewAgent = patch.reviewAgent
    if (patch.reviewModel !== undefined) this.reviewModel = patch.reviewModel
    if (patch.reviewReasoning !== undefined) this.reviewReasoning = patch.reviewReasoning
    if (patch.stackedPrsEnabled !== undefined) this.stackedPrsEnabled = patch.stackedPrsEnabled
    if (patch.generatePrGuidesOnOpen !== undefined) this.generatePrGuidesOnOpen = patch.generatePrGuidesOnOpen
    if (patch.reviewWarmingByProject !== undefined) this.reviewWarmingByProject = patch.reviewWarmingByProject
    if (patch.rateLimitBehavior !== undefined) this.rateLimitBehavior = patch.rateLimitBehavior
    if (patch.worktreeEnabled !== undefined) this.worktreeEnabled = patch.worktreeEnabled
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
    if (patch.extraInstructions !== undefined) this.extraInstructions = patch.extraInstructions
    if (patch.modelInstructions !== undefined) this.modelInstructions = patch.modelInstructions
    if (patch.keybindings !== undefined) this.keybindings = patch.keybindings
    if (patch.analyticsEnabled !== undefined) {
      this.analyticsEnabled = patch.analyticsEnabled
      setAnalyticsEnabled(patch.analyticsEnabled!)
      if (localApi.getPlatform() !== 'web') {
        void serverConnections.primaryApi().setAnalyticsConsent(patch.analyticsEnabled!).catch(() => {})
      }
    }
    if (patch.projectPanelOpen !== undefined) this.projectPanelOpen = patch.projectPanelOpen
    if (patch.splitProjectPanelOpen !== undefined)
      this.splitProjectPanelOpen = patch.splitProjectPanelOpen
    if (patch.projectPanelCollapsed !== undefined) this.projectPanelCollapsed = patch.projectPanelCollapsed
    if (patch.splitProjectPanelCollapsed !== undefined)
      this.splitProjectPanelCollapsed = patch.splitProjectPanelCollapsed
    if (patch.tabGroupMode !== undefined) this.tabGroupMode = patch.tabGroupMode
    if (patch.sidebarViewMode !== undefined) this.sidebarViewMode = patch.sidebarViewMode
    if (patch.onboardingCompleted !== undefined) this.onboardingCompleted = patch.onboardingCompleted
    this.saveSettings()
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

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        themeMode: this.themeMode,
        soundEnabled: this.soundEnabled,
        voiceModeEnabled: this.voiceModeEnabled,
        autoSendVoiceTranscripts: this.autoSendVoiceTranscripts,
        vadSilenceMs: this.vadSilenceMs,
        defaultEditor: this.defaultEditor,
        defaultTerminal: this.defaultTerminal,
        activeAgent: this.activeAgent,
        defaultModels: this.defaultModels,
        reviewAgent: this.reviewAgent,
        reviewModel: this.reviewModel,
        reviewReasoning: this.reviewReasoning,
        stackedPrsEnabled: this.stackedPrsEnabled,
        generatePrGuidesOnOpen: this.generatePrGuidesOnOpen,
        reviewWarmingByProject: this.reviewWarmingByProject,
        rateLimitBehavior: this.rateLimitBehavior,
        worktreeEnabled: this.worktreeEnabled,
        autoRenameSessions: this.autoRenameSessions,
        showDiffSummaryAfterTurn: this.showDiffSummaryAfterTurn,
        fontFamily: this.fontFamily,
        fontSize: this.fontSize,
        zoomFactor: this.zoomFactor,
        codeFontFamily: this.codeFontFamily,
        codeFontSize: this.codeFontSize,
        extraInstructions: this.extraInstructions,
        modelInstructions: this.modelInstructions,
        keybindings: this.keybindings,
        analyticsEnabled: this.analyticsEnabled,
        projectPanelOpen: this.projectPanelOpen,
        splitProjectPanelOpen: this.splitProjectPanelOpen,
        projectPanelCollapsed: this.projectPanelCollapsed,
        splitProjectPanelCollapsed: this.splitProjectPanelCollapsed,
        tabGroupMode: this.tabGroupMode,
        sidebarViewMode: this.sidebarViewMode,
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
