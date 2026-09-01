import { KEYBINDINGS, bindingsForScope, type BindingId } from './manifest'
import { comboEquals, defaultCombo, formatCombo } from './match'
import type { BindingDef, KeyCombo, Scope } from './types'

/** The user's rebinds, keyed by binding id. Absent = the shipped default. */
export type BindingOverrides = Record<string, KeyCombo>

/**
 * Display categories shared by the ⌘/ overlay and Settings → Keybindings, in
 * display order. A category maps to one or more binding scopes — contextual
 * scopes are grouped by area so neither surface is littered with one- or
 * two-shortcut entries. The underlying `scope` still governs when a binding
 * fires; this is display grouping only. Every scope with a declared binding
 * belongs to exactly one category so both surfaces expose the full manifest.
 */
export const KEYBINDING_CATEGORIES: { key: string; label: string; scopes: Scope[] }[] = [
  { key: 'global', label: 'Global', scopes: ['global'] },
  { key: 'diff-panel', label: 'Diff Panel', scopes: ['diff-panel'] },
  { key: 'workspace', label: 'Workspace', scopes: ['workspace', 'attachment-preview', 'snapshot-lightbox'] },
  { key: 'editors', label: 'Editors', scopes: ['file-editor', 'files-pane', 'plan-modal', 'document-modal'] },
  { key: 'pages', label: 'Pages', scopes: ['automations', 'insights', 'tasks', 'prs'] },
  { key: 'review', label: 'Review & Annotate', scopes: ['plan-action-bar', 'pr-review', 'design-annotation'] },
  { key: 'diagram', label: 'Diagram', scopes: ['diagram'] },
  { key: 'overlays', label: 'Overlays', scopes: ['saved-prompts', 'command-palette', 'go-to-file', 'project-search', 'shortcuts-help'] },
]

/** Per-scope labels: sub-headers inside a merged category, and the section
 *  heading for a search result that spans categories. */
export const SCOPE_LABELS = {
  global: 'Global',
  'diff-panel': 'Diff Panel',
  workspace: 'Workspace',
  'attachment-preview': 'Attachment preview',
  'snapshot-lightbox': 'Snapshot lightbox',
  'file-editor': 'File editor',
  'files-pane': 'Files pane',
  'plan-modal': 'Plan modal',
  'document-modal': 'Document modal',
  automations: 'Automations',
  insights: 'Insights',
  tasks: 'Tasks',
  prs: 'Pull requests',
  'plan-action-bar': 'Plan review',
  'pr-review': 'Pull request review',
  'design-annotation': 'Design annotation',
  diagram: 'Diagram',
  'saved-prompts': 'Saved prompts',
  'command-palette': 'Command palette',
  'go-to-file': 'Go to file',
  'project-search': 'Project search',
  'shortcuts-help': 'Keyboard shortcuts',
} satisfies Partial<Record<Scope, string>>

/** Every scope either surface lists, in category order. */
export const ALL_LISTED_SCOPES: Scope[] = KEYBINDING_CATEGORIES.flatMap((c) => c.scopes)

export function scopeLabel(scope: Scope): string {
  return SCOPE_LABELS[scope as keyof typeof SCOPE_LABELS] ?? scope
}

export function isBindingId(value: string): value is BindingId {
  return value in KEYBINDINGS
}

/** `null` when the binding ships unassigned and the user hasn't given it a key. */
export function effectiveCombo(id: BindingId, overrides: BindingOverrides): KeyCombo | null {
  return overrides[id] ?? defaultCombo(KEYBINDINGS[id])
}

export function isOverridden(id: BindingId, overrides: BindingOverrides): boolean {
  return id in overrides
}

/**
 * Rows that share a combo with another reachable row, mapped to the other row's
 * label. Conflicts are reported, not blocked: the last binding wins and both
 * rows say so, which is why this is symmetric.
 *
 * Only pairs where at least one side is a user rebind are reported. A few
 * shipped defaults collide deliberately (`pane.maximize` and the project panel
 * both answer ⌥M, resolved by `reserved` and by handler `enabled`), and calling
 * those a conflict on a fresh install would be noise the user cannot act on.
 */
export function conflictLabels(overrides: BindingOverrides): Map<BindingId, string> {
  const rows = (Object.entries(KEYBINDINGS) as Array<[BindingId, BindingDef]>)
    .map(([id, def]) => ({ id, def, combo: effectiveCombo(id, overrides), custom: id in overrides }))
  const conflicts = new Map<BindingId, string>()
  for (const row of rows) {
    if (!row.combo) continue
    for (const other of rows) {
      if (other.id === row.id || !other.combo) continue
      if (!row.custom && !other.custom) continue
      // A global binding is live under every scope, so it collides with all of
      // them; two contextual scopes never coexist and cannot collide.
      if (other.def.scope !== row.def.scope && other.def.scope !== 'global' && row.def.scope !== 'global') continue
      if (comboEquals(row.combo, other.combo)) {
        conflicts.set(row.id, other.def.label)
        break
      }
    }
  }
  return conflicts
}

/** Overrides with `id` bound to `combo`. Storing the shipped default would be
 *  redundant, so setting a binding back to its default clears the override. */
export function withBinding(id: BindingId, combo: KeyCombo, overrides: BindingOverrides): BindingOverrides {
  const next = { ...overrides }
  const fallback = defaultCombo(KEYBINDINGS[id])
  if (fallback && comboEquals(combo, fallback)) delete next[id]
  else next[id] = combo
  return next
}

export function withoutBinding(id: BindingId, overrides: BindingOverrides): BindingOverrides {
  const next = { ...overrides }
  delete next[id]
  return next
}

/** Free-text match over a row: its label, its scope, its group, and its keys.
 *  "unassigned" finds every action still waiting for a shortcut. */
export function matchesQuery(def: BindingDef, combo: KeyCombo | null, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    def.label.toLowerCase().includes(q) ||
    scopeLabel(def.scope).toLowerCase().includes(q) ||
    def.group.toLowerCase().includes(q) ||
    (combo === null
      ? 'unassigned'.includes(q)
      : formatCombo(combo).join('').toLowerCase().includes(q))
  )
}

/** Rows of one scope, split by their declared `group`, in declaration order. */
export function groupsForScope(scope: Scope): Array<{ group: string; rows: Array<{ id: BindingId; def: BindingDef }> }> {
  const order: string[] = []
  const map = new Map<string, Array<{ id: BindingId; def: BindingDef }>>()
  for (const [id, def] of bindingsForScope(scope)) {
    let rows = map.get(def.group)
    if (!rows) {
      rows = []
      map.set(def.group, rows)
      order.push(def.group)
    }
    rows.push({ id, def })
  }
  return order.map((group) => ({ group, rows: map.get(group)! }))
}
