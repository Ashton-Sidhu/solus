import { createContext } from 'svelte'
import { KEYBINDINGS, type BindingId } from './manifest'
import { comboFromEvent, comboIsTextInput, defaultCombo, eventMatches, isMac } from './match'
import type { BindingDef, Handler, KeyCombo, RegisterOptions, Scope } from './types'

type ScopeEntry = { scope: Scope; exclusive: boolean }
type HandlerEntry = { handler: Handler; opts: RegisterOptions }

// Group the (static) manifest by scope once at module init. dispatch() then
// iterates only the current scope's bindings — no Object.entries() allocation
// per scope per keydown. Overrides only swap a binding's combo, never its
// scope, so this grouping never needs rebuilding.
const BINDINGS_BY_SCOPE = new Map<Scope, Array<[BindingId, BindingDef]>>()
for (const [id, def] of Object.entries(KEYBINDINGS) as Array<[BindingId, BindingDef]>) {
  let arr = BINDINGS_BY_SCOPE.get(def.scope)
  if (!arr) {
    arr = []
    BINDINGS_BY_SCOPE.set(def.scope, arr)
  }
  arr.push([id, def])
}

// macOS dead keys: ⌥+these start an IME composition (e.g. ⌥N → ˜) that
// preventDefault() can't suppress, so the accent leaks into the focused editor.
// Don't bind ⌥ shortcuts to these codes — pick another letter instead.
const MAC_DEAD_KEY_CODES = new Set(['KeyE', 'KeyI', 'KeyU', 'KeyN', 'Backquote'])

/** True when the keystroke lands in a text field — <input>, <textarea>, or any
 *  contentEditable region (the chat composer's Tiptap editor included). */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable === true
  )
}

export class KeybindingsContext {
  private scopeStack: ScopeEntry[] = []
  // Multiple components (e.g. one ActionOrb per tab) can register the same
  // binding ID. All entries are checked; the first whose `enabled` passes fires.
  private handlers = new Map<BindingId, Set<HandlerEntry>>()
  overrides: Record<string, KeyCombo> = {}

  setOverrides(overrides: Record<string, KeyCombo>): void {
    this.overrides = overrides
  }

  activeScopes(): Scope[] {
    const seen = new Set<Scope>()
    const result: Scope[] = []
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const s = this.scopeStack[i].scope
      if (!seen.has(s)) { seen.add(s); result.push(s) }
    }
    return result
  }

  pushScope(scope: Scope, exclusive = false): () => void {
    const entry: ScopeEntry = { scope, exclusive }
    this.scopeStack.push(entry)
    return () => {
      const idx = this.scopeStack.lastIndexOf(entry)
      if (idx !== -1) this.scopeStack.splice(idx, 1)
    }
  }

  register(id: BindingId, handler: Handler, opts: RegisterOptions = {}): () => void {
    let set = this.handlers.get(id)
    if (!set) { set = new Set(); this.handlers.set(id, set) }
    const entry: HandlerEntry = { handler, opts }
    set.add(entry)
    return () => {
      this.handlers.get(id)?.delete(entry)
    }
  }

  dispatch(e: KeyboardEvent): void {
    // While the user is typing in an editable element, a keystroke that's just a
    // printable key (e.g. `/` to focus a pane's search) is indistinguishable
    // from typing — firing a binding for it would preventDefault() and swallow
    // the character. Such keystrokes yield to the field; real shortcuts
    // (⌘/⌃/⌥) still fire.
    const eventCombo = comboFromEvent(e)
    const swallowsTyping =
      isEditableTarget(e.target) &&
      eventCombo !== null &&
      comboIsTextInput(eventCombo)
    // A printable-key keystroke on an editable target yields to the field: no
    // binding may fire (any combo it could match is itself a text-input combo,
    // skipped below). Bail before the scan so typing costs zero iteration.
    if (swallowsTyping) return

    // Determine which scopes are in play: if any exclusive scope is active,
    // only check that scope; otherwise check all active scopes newest-first.
    const exclusiveIdx = this.scopeStack.findLastIndex((s) => s.exclusive)
    const start = this.scopeStack.length - 1
    const end = exclusiveIdx !== -1 ? exclusiveIdx : 0

    for (let i = start; i >= end; i--) {
      const { scope } = this.scopeStack[i]
      const bindings = BINDINGS_BY_SCOPE.get(scope)
      if (!bindings) continue
      for (const [id, def] of bindings) {
        const combo = (this.overrides[id] as KeyCombo | undefined) ?? defaultCombo(def)
        // An override replaces the primary combo but keeps the built-in aliases.
        const matched =
          eventMatches(e, combo) ||
          (def.aliases?.some((a) => eventMatches(e, a)) ?? false)
        if (!matched) continue
        // Auto-repeat (held key) only fires bindings that opt in (e.g. palette
        // navigation); everything else ignores repeats so toggles/actions don't
        // double-fire while a key is held.
        if (e.repeat && !def.repeatable) return
        const entries = this.handlers.get(id)
        if (!entries) continue
        for (const entry of entries) {
          if (entry.opts.enabled?.() === false) continue
          e.preventDefault()
          // macOS dead keys (e.g. ⌥N → ˜) start an IME composition that
          // preventDefault() above can't stop, so the accent still leaks into
          // the focused editor (notably in Safari). We don't try to swallow it —
          // just warn so the offending binding gets moved to a non-dead key.
          if (isMac && e.altKey && MAC_DEAD_KEY_CODES.has(combo.code)) {
            console.warn(
              `[keybindings] "${id}" is bound to ⌥${combo.code} — a macOS dead key. ` +
                `Its accent character may leak into the input. Rebind to a non-dead key.`,
            )
          }
          void Promise.resolve(entry.handler())
          return
        }
      }
    }
  }
}

export const [getKeybindingsContext, setKeybindingsContext] =
  createContext<KeybindingsContext>()
