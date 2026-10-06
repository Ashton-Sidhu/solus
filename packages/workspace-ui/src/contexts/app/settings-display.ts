/**
 * Display adapters for settings (plans/018 §3.5): each function paints one
 * value onto the document. They read no store and own no state; the settings
 * context calls them when a value changes. Theme, fonts, text sizes, and zoom
 * resolve here on each device, so a synced `themeMode: system` paints this
 * device's own appearance.
 */

import type { AppCodeFontFamily, AppFontFamily } from '@solus/contracts/types'
import type { DocumentFontFamily, FontFamilyPreference, FontPreferenceKey, PersonalSettings, PromptFontFamily } from '@solus/contracts/settings'
import { localApi } from '@solus/client-core/local-api'
import { customFamilyStack } from '../../lib/font-family'

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

export function applyTheme(isDark: boolean): void {
  // The opaque form of `--solus-container-bg`. Every web surface — the mobile
  // shell and the desktop root alike — paints that colour edge to edge, so the
  // page background and Safari's toolbar have to *render* as the same value or
  // the seam between browser chrome and app reads as two different blacks. The
  // page takes it neat; the toolbar takes it through `toolbarTint`.
  const edgeColor = isDark ? '#262522' : '#fffffd'
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

export function applyFontSize(size: number): void {
  document.documentElement.style.setProperty('--solus-font-scale', String(size / BASE_FONT_SIZE))
}

/** Desktop-only: the web client leans on native browser zoom instead, so the
 *  bridge method is absent there and this is a no-op. */
export function applyZoomFactor(factor: number): void {
  localApi.setZoomFactor?.(factor)
}

export const IS_MAC_OS = /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? '')
// The platform UI face: San Francisco on Apple devices, Segoe UI on Windows,
// and the desktop's own face elsewhere.
const DEFAULT_APP_FONT_FAMILY: AppFontFamily = 'system'

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

export function applyFontFamily(fontFamily: FontFamilyPreference): void {
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

export function applyDocumentFontFamily(documentFontFamily: FontFamilyPreference): void {
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

export function applyDocumentFontSize(size: number): void {
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

export function applyPromptFontFamily(promptFontFamily: FontFamilyPreference): void {
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

export function applyPromptFontSize(size: number): void {
  // A scale like the code font: `--solus-prompt-font-size` is a rem calc in
  // index.css, so the box follows zoom exactly as every other rung does.
  document.documentElement.style.setProperty('--solus-prompt-font-scale', String(size / DEFAULT_PROMPT_FONT_SIZE))
}

export function applyFontSmoothing(enabled: boolean): void {
  // Inherited from the root; `auto` restores the platform default, which macOS
  // renders with heavier stem darkening.
  document.documentElement.style.setProperty('--solus-font-smoothing', enabled ? 'antialiased' : 'auto')
}

export function applyAssistantTextOpacity(percent: number): void {
  document.documentElement.style.setProperty('--solus-assistant-text-opacity', `${percent}%`)
}

const DEFAULT_CODE_FONT_SIZE = 12
const DEFAULT_CODE_FONT_FAMILY: AppCodeFontFamily = 'jetbrains-mono'

export function applyCodeFontFamily(codeFontFamily: FontFamilyPreference): void {
  const preset = APP_CODE_FONT_FAMILIES.find((option) => option.id === codeFontFamily)
  const fallback = APP_CODE_FONT_FAMILIES.find((option) => option.id === DEFAULT_CODE_FONT_FAMILY) ?? APP_CODE_FONT_FAMILIES[0]
  document.documentElement.style.setProperty(
    '--solus-code-font-family',
    preset?.stack ?? customFamilyStack(codeFontFamily, fallback.stack),
  )
}

export function applyCodeFontSize(size: number): void {
  // Set only the scale multiplier — `--solus-code-font-size` is a rem-based
  // calc() (see index.css), so the code/diff font scales with the screen via the
  // root font-size AND with this user preference. Mirrors applyFontSize. Hard-
  // setting a px value here would freeze the code font and break screen scaling.
  document.documentElement.style.setProperty('--solus-code-font-scale', String(size / DEFAULT_CODE_FONT_SIZE))
}

/** How each font preference paints, given the family this device resolved (an installed override or the synced preset). */
export const FONT_DISPLAY = {
  fontFamily: applyFontFamily,
  codeFontFamily: applyCodeFontFamily,
  documentFontFamily: applyDocumentFontFamily,
  promptFontFamily: applyPromptFontFamily,
} satisfies Record<FontPreferenceKey, (family: FontFamilyPreference) => void>

export type PaintedSizeKey = 'fontSize' | 'codeFontSize' | 'documentFontSize' | 'promptFontSize' | 'assistantTextOpacity'

/** How each other painted personal value applies. A key absent here changes no document style. */
export const PERSONAL_DISPLAY = {
  fontSize: applyFontSize,
  codeFontSize: applyCodeFontSize,
  documentFontSize: applyDocumentFontSize,
  promptFontSize: applyPromptFontSize,
  assistantTextOpacity: applyAssistantTextOpacity,
} satisfies { [K in PaintedSizeKey]: (value: PersonalSettings[K]) => void }

export function isPaintedSizeKey(key: string): key is PaintedSizeKey {
  return Object.hasOwn(PERSONAL_DISPLAY, key)
}
