export type KeyCombo = {
  code: string
  alt?: boolean
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  /** true = meta on macOS, ctrl elsewhere */
  mod?: boolean
}

export type Scope =
  | 'global'
  | 'diff-panel'
  | 'file-editor'
  | 'files-pane'
  | 'plan-modal'
  | 'document-modal'
  | 'plan-gallery'
  | 'folio-gallery'
  | 'automations'
  | 'tasks'
  | 'prs'
  | 'design-annotation'
  | 'plan-action-bar'
  | 'attachment-preview'
  | 'diagram'
  | 'command-palette'
  | 'shortcuts-help'

export type BindingDef = {
  combo: KeyCombo
  /**
   * Web-safe default, used in the web shell when `combo` is a browser-reserved
   * combo (⌘T/⌘W/⌘N/…) the page can't preventDefault. Falls back to `combo`.
   */
  web?: KeyCombo
  /** Extra combos that trigger the same action (not shown in the shortcuts help). */
  aliases?: KeyCombo[]
  /**
   * Fire on auto-repeat (held key) instead of only the initial keydown. Opt-in
   * for list/cursor navigation (e.g. palette ↑/↓) so holding the key keeps
   * moving; left off for toggles/actions that must not double-fire.
   */
  repeatable?: boolean
  scope: Scope
  label: string
  group: string
}

export type Handler = () => void | Promise<void>

export type RegisterOptions = {
  enabled?: () => boolean
}
