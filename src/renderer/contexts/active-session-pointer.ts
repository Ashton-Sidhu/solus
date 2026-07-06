import type { AgentId } from '../../shared/types'

// Cross-window session pickup. Both Electron windows share one localStorage;
// these two keys are the only state that crosses windows (tab stores stay
// per-window):
//
//  - POINTER_KEY: the latest session = the session the last message was sent
//    in, whichever window sent it. The pill reads it on summon so it lands on
//    what the user was just working on (automatic, pull-based). The editor
//    never follows the pointer; its tab strip is a curated workspace.
//  - HANDOFF_KEY: explicit "continue in the other mode" (⌥⇧E) — written by the
//    window being left, addressed to a target mode, consumed once by that
//    mode's window (on mount or via the cross-window `storage` event).

export interface ActiveSessionPointer {
  sessionId: string
  provider: AgentId
  cwd: string
  title: string | null
  writer: 'pill' | 'editor'
  updatedAt: number
}

export interface SessionHandoff {
  sessionId: string
  provider: AgentId
  cwd: string
  title: string | null
  target: 'pill' | 'editor'
  updatedAt: number
}

const POINTER_KEY = 'solus-active-session'
const HANDOFF_KEY = 'solus-session-handoff'
const HANDOFF_TTL_MS = 30_000

function isElectron(): boolean {
  try {
    return window.solus.getPlatform() !== 'web'
  } catch {
    return false
  }
}

export function writeActiveSessionPointer(pointer: Omit<ActiveSessionPointer, 'updatedAt'>): void {
  if (!isElectron()) return
  try {
    localStorage.setItem(POINTER_KEY, JSON.stringify({ ...pointer, updatedAt: Date.now() }))
  } catch {}
}

export function readActiveSessionPointer(): ActiveSessionPointer | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(POINTER_KEY) || 'null')
    if (typeof parsed?.sessionId !== 'string' || typeof parsed?.updatedAt !== 'number') return null
    return parsed as ActiveSessionPointer
  } catch {
    return null
  }
}

export function writeSessionHandoff(handoff: Omit<SessionHandoff, 'updatedAt'>): void {
  if (!isElectron()) return
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...handoff, updatedAt: Date.now() }))
  } catch {}
}

/** Deliver pending handoffs addressed to `target` — one already stashed when
 *  this runs (the switch may have just created this window) and any that
 *  arrive later while it stays open. Handoffs addressed to the other mode are
 *  left in place for that window's consumer. Returns an unsubscribe. */
export function consumeSessionHandoff(
  target: 'pill' | 'editor',
  onSession: (handoff: SessionHandoff) => void,
): () => void {
  const consume = () => {
    try {
      const raw = localStorage.getItem(HANDOFF_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed?.target !== target) return
      localStorage.removeItem(HANDOFF_KEY)
      if (typeof parsed?.sessionId !== 'string') return
      if (Date.now() - (parsed.updatedAt ?? 0) > HANDOFF_TTL_MS) return
      onSession(parsed as SessionHandoff)
    } catch {}
  }
  consume()
  const onStorage = (e: StorageEvent) => {
    if (e.key === HANDOFF_KEY && e.newValue) consume()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
