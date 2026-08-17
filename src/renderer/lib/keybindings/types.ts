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
  | 'workspace'
  | 'automations'
  | 'insights'
  | 'tasks'
  | 'prs'
  | 'pr-review'
  | 'design-annotation'
  | 'plan-action-bar'
  | 'attachment-preview'
  | 'saved-prompts'
  | 'diagram'
  | 'command-palette'
  | 'project-search'
  | 'go-to-file'
  | 'shortcuts-help'
  /** First-run onboarding. Exclusive and empty: while it is up nothing behind
   *  it may fire, so the shortcuts stage can invite real key presses without
   *  the real commands running under the overlay. */
  | 'onboarding'

export type BindingDef = {
  /**
   * `null` ships the action unassigned: it appears in Settings → Keybindings so
   * a user can give it a key, but nothing fires until they do. Use it for a
   * surface that is reachable by pointer and has no obvious free combo left.
   */
  combo: KeyCombo | null
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
