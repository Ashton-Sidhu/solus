/** Unified settings context: theme + editor/terminal/agent + rate-limit + worktree toggle. */

import { createContext } from 'svelte'
import type { AgentId, AppCodeFontFamily, AppFontFamily, EditorId, ReasoningEffort, SettingsCtx, TerminalAppId } from '../../shared/types'
import { REASONING_EFFORT_LABELS } from '../../shared/types'
import type { KeyCombo } from '../lib/keybindings/types'
import { KEYBINDINGS } from '../lib/keybindings/manifest'
import { setAnalyticsEnabled } from '../lib/analytics'

export type ThemeMode = 'system' | 'light' | 'dark'

export type RateLimitBehavior = 'ask' | 'queue' | 'continue' | 'stop'
export type ProjectPanelSectionId = 'git' | 'run' | 'works' | 'automations' | 'tasks'

const DEFAULT_PROJECT_PANEL_COLLAPSED: Record<ProjectPanelSectionId, boolean> = {
  git: false,
  run: false,
  works: false,
  automations: false,
  tasks: false,
}

/** Default height (px) of the bottom run-log dock. */
function defaultRunDockHeight(): number {
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080
  return Math.max(96, Math.round(viewportHeight * 0.33))
}

export const TAB_GROUP_MODES = ['flat', 'status', 'unread'] as const
export type TabGroupMode = (typeof TAB_GROUP_MODES)[number]

export type SettingsFields = {
  themeMode: ThemeMode
  soundEnabled: boolean
  voiceModeEnabled: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  defaultTerminal: TerminalAppId | null
  activeAgent: AgentId
  reviewAgent: AgentId | null     // review companion backend; null → use activeAgent
  reviewModel: string | null      // review companion model; null → backend default
  reviewReasoning: ReasoningEffort | null  // review companion reasoning effort; null → model default
  rateLimitBehavior: RateLimitBehavior
  worktreeEnabled: boolean
  fontFamily: AppFontFamily
  fontSize: number
  codeFontFamily: AppCodeFontFamily
  codeFontSize: number
  extraInstructions: string
  modelInstructions: Record<string, string>
  keybindings: Record<string, KeyCombo>
  analyticsEnabled: boolean
  projectPanelOpen: boolean
  projectPanelCollapsed: Record<ProjectPanelSectionId, boolean>
  runDockOpen: boolean
  runDockHeight: number
  tabGroupMode: TabGroupMode
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
const MOBILE_QUERY = '(max-width: 767px)'
const DEFAULT_FONT_SIZE = typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches ? 11 : 13

function applyFontSize(size: number): void {
  document.documentElement.style.setProperty('--solus-font-scale', String(size / BASE_FONT_SIZE))
}

const IS_MAC_OS = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)

// `weight` is the body weight tuned for crispest rendering of each typeface at
// ~13px under grayscale antialiasing (-webkit-font-smoothing: antialiased).
// Grayscale AA thins glyphs, so Inter/DM Sans need the 500 (Medium named
// instance) bump or they look washed out. Grotesque, system and serif faces
// render heavier — at 500 their strokes muddy and counters fill, so they're
// crispest at their native 400 (Regular). SF Pro Text is the exception: addressed
// by name (not -apple-system) it loses macOS's optical-size tuning and renders
// heavy under grayscale AA, so it's taken to 300 (Light) to read as Regular. All
// values are named instances on the variable fonts, which are hinted and therefore
// a touch sharper.
export const APP_FONT_FAMILIES: { id: AppFontFamily; label: string; stack: string; weight: number }[] = [
  { id: 'inter', label: 'Inter', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 500 },
  { id: 'dm-sans', label: 'DM Sans', stack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 500 },
  { id: 'system', label: 'System', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", weight: 400 },
  { id: 'geist', label: 'Geist Sans', stack: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", weight: 400 },
  { id: 'lora', label: 'Lora', stack: "'Lora', Georgia, 'Times New Roman', serif", weight: 400 },
  ...(IS_MAC_OS ? [{ id: 'sf-pro-text' as const, label: 'SF Pro Text', stack: "'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", weight: 300 }] : []),
  { id: 'sf-mono', label: 'SF Mono', stack: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace", weight: 400 },
]

function applyFontFamily(fontFamily: AppFontFamily): void {
  const family = APP_FONT_FAMILIES.find((option) => option.id === fontFamily) ?? APP_FONT_FAMILIES[0]
  document.documentElement.style.setProperty('--solus-font-family', family.stack)
  // Each typeface has its own crisp body weight — drive both the body and the
  // (currently matched) secondary-label weight from it.
  document.documentElement.style.setProperty('--solus-font-weight-body', String(family.weight))
  document.documentElement.style.setProperty('--solus-font-weight-secondary', String(family.weight))
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
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(id in KEYBINDINGS)) continue
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.code !== 'string' || !r.code) continue
    if (MOD_KEYS.some((k) => r[k] !== undefined && typeof r[k] !== 'boolean')) continue
    const combo: KeyCombo = { code: r.code }
    for (const k of MOD_KEYS) if (r[k] === true) combo[k] = true
    out[id] = combo
  }
  return out
}

/**
 * Drop non-string values so a hand-edited/stale blob can't break dispatch.
 */
function loadModelInstructions(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object') return out
  for (const [id, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string') out[id] = text
  }
  return out
}

function loadProjectPanelCollapsed(value: unknown): Record<ProjectPanelSectionId, boolean> {
  const collapsed = { ...DEFAULT_PROJECT_PANEL_COLLAPSED }
  if (!value || typeof value !== 'object') return collapsed
  for (const id of Object.keys(DEFAULT_PROJECT_PANEL_COLLAPSED) as ProjectPanelSectionId[]) {
    const next = (value as Record<string, unknown>)[id]
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
        themeMode: (['light', 'dark'].includes(parsed.themeMode) ? parsed.themeMode : 'light') as ThemeMode,
        soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : true,
        voiceModeEnabled: typeof parsed.voiceModeEnabled === 'boolean' ? parsed.voiceModeEnabled : false,
        vadSilenceMs: typeof parsed.vadSilenceMs === 'number' ? Math.max(1000, Math.min(8000, parsed.vadSilenceMs)) : 1500,
        defaultEditor: VALID_EDITORS.includes(parsed.defaultEditor) ? parsed.defaultEditor : null,
        defaultTerminal: VALID_TERMINALS.includes(parsed.defaultTerminal) ? parsed.defaultTerminal : null,
        activeAgent: VALID_AGENTS.includes(parsed.activeAgent) ? parsed.activeAgent : 'claude-code',
        reviewAgent: VALID_AGENTS.includes(parsed.reviewAgent) ? parsed.reviewAgent : null,
        reviewModel: typeof parsed.reviewModel === 'string' ? parsed.reviewModel : null,
        reviewReasoning: parsed.reviewReasoning in REASONING_EFFORT_LABELS ? parsed.reviewReasoning : null,
        rateLimitBehavior: (['ask', 'queue', 'continue', 'stop'].includes(parsed.rateLimitBehavior) ? parsed.rateLimitBehavior : 'ask') as RateLimitBehavior,
        worktreeEnabled: typeof parsed.worktreeEnabled === 'boolean' ? parsed.worktreeEnabled : false,
        fontFamily: VALID_FONT_FAMILIES.includes(parsed.fontFamily) ? parsed.fontFamily : 'inter',
        fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= 8 ? parsed.fontSize : DEFAULT_FONT_SIZE,
        codeFontFamily: VALID_CODE_FONT_FAMILIES.includes(parsed.codeFontFamily) ? parsed.codeFontFamily : 'sf-mono',
        codeFontSize: typeof parsed.codeFontSize === 'number' && parsed.codeFontSize >= 8 ? parsed.codeFontSize : DEFAULT_CODE_FONT_SIZE,
        extraInstructions: typeof parsed.extraInstructions === 'string' ? parsed.extraInstructions : '',
        modelInstructions: loadModelInstructions(parsed.modelInstructions),
        keybindings: sanitizeKeybindings(parsed.keybindings),
        analyticsEnabled: typeof parsed.analyticsEnabled === 'boolean' ? parsed.analyticsEnabled : true,
        projectPanelOpen: typeof parsed.projectPanelOpen === 'boolean' ? parsed.projectPanelOpen : false,
        projectPanelCollapsed: loadProjectPanelCollapsed(parsed.projectPanelCollapsed),
        runDockOpen: typeof parsed.runDockOpen === 'boolean' ? parsed.runDockOpen : false,
        runDockHeight: typeof parsed.runDockHeight === 'number' && parsed.runDockHeight >= 96 ? parsed.runDockHeight : defaultRunDockHeight(),
        tabGroupMode: ((TAB_GROUP_MODES as readonly string[]).includes(parsed.tabGroupMode) ? parsed.tabGroupMode : 'flat') as TabGroupMode,
      }
    }
  } catch {}
  return {
    themeMode: 'dark',
    soundEnabled: true,
    voiceModeEnabled: false,
    vadSilenceMs: 1500,
    defaultEditor: 'vim',
    defaultTerminal: 'default-terminal',
    activeAgent: 'claude-code',
    reviewAgent: null,
    reviewModel: null,
    reviewReasoning: null,
    rateLimitBehavior: 'ask',
    worktreeEnabled: false,
    fontFamily: 'inter',
    fontSize: DEFAULT_FONT_SIZE,
    codeFontFamily: 'sf-mono',
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
    extraInstructions: '',
    modelInstructions: {},
    keybindings: {},
    analyticsEnabled: true,
    projectPanelOpen: false,
    projectPanelCollapsed: { ...DEFAULT_PROJECT_PANEL_COLLAPSED },
    runDockOpen: false,
    runDockHeight: defaultRunDockHeight(),
    tabGroupMode: 'flat',
  }
}

export class SettingsContext {
  themeMode = $state<ThemeMode>('dark')
  soundEnabled = $state(true)
  voiceModeEnabled = $state(false)
  vadSilenceMs = $state(1500)
  defaultEditor = $state<EditorId | null>(null)
  defaultTerminal = $state<TerminalAppId | null>(null)
  activeAgent = $state<AgentId>('claude-code')
  reviewAgent = $state<AgentId | null>(null)
  reviewModel = $state<string | null>(null)
  reviewReasoning = $state<ReasoningEffort | null>(null)
  rateLimitBehavior = $state<RateLimitBehavior>('ask')
  worktreeEnabled = $state(false)
  fontFamily = $state<AppFontFamily>('inter')
  fontSize = $state(13)
  codeFontFamily = $state<AppCodeFontFamily>('sf-mono')
  codeFontSize = $state(DEFAULT_CODE_FONT_SIZE)
  extraInstructions = $state('')
  modelInstructions = $state<Record<string, string>>({})
  keybindings = $state<Record<string, KeyCombo>>({})
  analyticsEnabled = $state(true)
  projectPanelOpen = $state(false)
  projectPanelCollapsed = $state<Record<ProjectPanelSectionId, boolean>>({ ...DEFAULT_PROJECT_PANEL_COLLAPSED })
  runDockOpen = $state(false)
  runDockHeight = $state(defaultRunDockHeight())
  tabGroupMode = $state<TabGroupMode>('flat')
  private _systemIsDark = $state(true)

  constructor() {
    const saved = loadSettings()
    this.themeMode = saved.themeMode
    this.soundEnabled = saved.soundEnabled
    this.voiceModeEnabled = saved.voiceModeEnabled
    this.vadSilenceMs = saved.vadSilenceMs
    this.defaultEditor = saved.defaultEditor
    this.defaultTerminal = saved.defaultTerminal
    this.activeAgent = saved.activeAgent
    this.reviewAgent = saved.reviewAgent
    this.reviewModel = saved.reviewModel
    this.reviewReasoning = saved.reviewReasoning
    this.rateLimitBehavior = saved.rateLimitBehavior
    this.worktreeEnabled = saved.worktreeEnabled
    this.fontFamily = saved.fontFamily
    this.fontSize = saved.fontSize
    this.codeFontFamily = saved.codeFontFamily
    this.codeFontSize = saved.codeFontSize
    this.extraInstructions = saved.extraInstructions
    this.modelInstructions = saved.modelInstructions
    this.keybindings = saved.keybindings
    this.analyticsEnabled = saved.analyticsEnabled
    this.projectPanelOpen = saved.projectPanelOpen
    this.projectPanelCollapsed = saved.projectPanelCollapsed
    this.runDockOpen = saved.runDockOpen
    this.runDockHeight = saved.runDockHeight
    this.tabGroupMode = saved.tabGroupMode

    // Must run before first paint so CSS variables resolve to the saved palette.
    applyTheme(saved.themeMode !== 'light')
    applyFontFamily(saved.fontFamily)
    applyFontSize(saved.fontSize)
    applyCodeFontFamily(saved.codeFontFamily)
    applyCodeFontSize(saved.codeFontSize)
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

  update(patch: Partial<SettingsFields>): void {
    if (patch.themeMode !== undefined) {
      this.themeMode = patch.themeMode
      const resolved = patch.themeMode === 'system' ? this._systemIsDark : patch.themeMode === 'dark'
      applyTheme(resolved)
    }
    if (patch.soundEnabled !== undefined) this.soundEnabled = patch.soundEnabled
    if (patch.voiceModeEnabled !== undefined) this.voiceModeEnabled = patch.voiceModeEnabled
    if (patch.vadSilenceMs !== undefined) this.vadSilenceMs = Math.max(1000, Math.min(8000, patch.vadSilenceMs))
    if (patch.defaultEditor !== undefined) this.defaultEditor = patch.defaultEditor
    if (patch.defaultTerminal !== undefined) this.defaultTerminal = patch.defaultTerminal
    if (patch.activeAgent !== undefined) this.activeAgent = patch.activeAgent
    if (patch.reviewAgent !== undefined) this.reviewAgent = patch.reviewAgent
    if (patch.reviewModel !== undefined) this.reviewModel = patch.reviewModel
    if (patch.reviewReasoning !== undefined) this.reviewReasoning = patch.reviewReasoning
    if (patch.rateLimitBehavior !== undefined) this.rateLimitBehavior = patch.rateLimitBehavior
    if (patch.worktreeEnabled !== undefined) this.worktreeEnabled = patch.worktreeEnabled
    if (patch.fontFamily !== undefined) {
      this.fontFamily = patch.fontFamily
      applyFontFamily(this.fontFamily)
    }
    if (patch.fontSize !== undefined) {
      this.fontSize = Math.max(8, patch.fontSize)
      applyFontSize(this.fontSize)
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
    }
    if (patch.projectPanelOpen !== undefined) this.projectPanelOpen = patch.projectPanelOpen
    if (patch.projectPanelCollapsed !== undefined) this.projectPanelCollapsed = patch.projectPanelCollapsed
    if (patch.runDockOpen !== undefined) this.runDockOpen = patch.runDockOpen
    if (patch.runDockHeight !== undefined) this.runDockHeight = Math.max(96, patch.runDockHeight)
    if (patch.tabGroupMode !== undefined) this.tabGroupMode = patch.tabGroupMode
    this.saveSettings()
  }

  // OS-supplied system theme; not persisted.
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
        vadSilenceMs: this.vadSilenceMs,
        defaultEditor: this.defaultEditor,
        defaultTerminal: this.defaultTerminal,
        activeAgent: this.activeAgent,
        reviewAgent: this.reviewAgent,
        reviewModel: this.reviewModel,
        reviewReasoning: this.reviewReasoning,
        rateLimitBehavior: this.rateLimitBehavior,
        worktreeEnabled: this.worktreeEnabled,
        fontFamily: this.fontFamily,
        fontSize: this.fontSize,
        codeFontFamily: this.codeFontFamily,
        codeFontSize: this.codeFontSize,
        extraInstructions: this.extraInstructions,
        modelInstructions: this.modelInstructions,
        keybindings: this.keybindings,
        analyticsEnabled: this.analyticsEnabled,
        projectPanelOpen: this.projectPanelOpen,
        projectPanelCollapsed: this.projectPanelCollapsed,
        runDockOpen: this.runDockOpen,
        runDockHeight: this.runDockHeight,
        tabGroupMode: this.tabGroupMode,
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

export const [getSettingsContext, setSettingsContext] = createContext<SettingsContext>()
