import { comboFromEvent, isMac } from './match'
import type { KeyCombo } from './types'

/** Modifiers currently held, in the canonical ⌘ ⌃ ⌥ ⇧ order, so a capture chip
 *  can echo them while the user is still reaching for the key. */
function heldModifiers(e: KeyboardEvent): string[] {
  const keys: string[] = []
  // Mirrors `formatCombo`: the platform's primary modifier always reads ⌘.
  if (isMac ? e.metaKey : e.ctrlKey) keys.push('⌘')
  if (isMac ? e.ctrlKey : e.metaKey) keys.push(isMac ? '⌃' : '⌘')
  if (e.altKey) keys.push('⌥')
  if (e.shiftKey) keys.push('⇧')
  return keys
}

/**
 * The one row in the app that is listening for a key press. Module-level so the
 * ⌘/ overlay and the settings editor share it: opening a capture in one closes
 * the capture in the other without committing, which is the "one at a time"
 * rule, and there is never more than one window listener consuming the press.
 */
class BindingCapture {
  /** A `BindingId`, or `app:primary` / `app:secondary` for the OS summon rows. */
  id = $state<string | null>(null)
  private held = $state<string[]>([])
  private commit: ((combo: KeyCombo) => void) | null = null
  private listener: ((e: KeyboardEvent) => void) | null = null

  start(id: string, commit: (combo: KeyCombo) => void): void {
    this.detach()
    this.id = id
    this.held = []
    this.commit = commit
    // Capture phase, so the press is consumed before the global dispatcher, the
    // settings page, or the overlay's own Escape binding can read it.
    this.listener = (e) => this.handle(e)
    window.addEventListener('keydown', this.listener, { capture: true })
  }

  cancel(): void {
    this.detach()
    this.id = null
    this.held = []
  }

  /** Modifiers held so far, or the invitation while nothing is pressed. */
  get pendingText(): string {
    return this.held.length > 0 ? this.held.join(' ') : 'Press keys'
  }

  private detach(): void {
    if (this.listener) window.removeEventListener('keydown', this.listener, { capture: true })
    this.listener = null
    this.commit = null
  }

  private handle(e: KeyboardEvent): void {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.code === 'Escape') {
      this.cancel()
      return
    }
    const combo = comboFromEvent(e)
    // Modifier-only: echo it and keep waiting for the key that commits.
    if (!combo) {
      this.held = heldModifiers(e)
      return
    }
    const commit = this.commit
    this.cancel()
    commit?.(combo)
  }
}

export const bindingCapture = new BindingCapture()
