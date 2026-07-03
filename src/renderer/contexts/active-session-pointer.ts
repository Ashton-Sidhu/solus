import type { AgentId } from '../../shared/types'

// Cross-window session pickup. Both Electron windows share one localStorage;
// these two keys are the only state that crosses windows (tab stores stay
// per-window):
//
//  - POINTER_KEY: the latest session = the session the last message was sent
//    in, whichever window sent it. The pill reads it on summon so it lands on
//    what the user was just working on (automatic, pull-based).
//  - HANDOFF_KEY: explicit pill→editor handoff — written when the user toggles
//    pill→editor, consumed once by the editor window (on mount or via the
//    cross-window `storage` event). The editor never follows the ambient
//    pointer; its tab strip is a curated workspace.

export interface ActiveSessionPointer {
  sessionId: string
  provider: AgentId
  cwd: string
  title: string | null
  writer: 'pill' | 'editor'
  updatedAt: number
}

export type SessionHandoff = Omit<ActiveSessionPointer, 'writer'>

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

/** Editor window: deliver a pending pill→editor handoff — one already stashed
 *  when this runs (the toggle may have just created this window) and any that
 *  arrive later while it stays open. Returns an unsubscribe. */
export function consumeSessionHandoff(onSession: (handoff: SessionHandoff) => void): () => void {
  const consume = () => {
    try {
      const raw = localStorage.getItem(HANDOFF_KEY)
      if (!raw) return
      localStorage.removeItem(HANDOFF_KEY)
      const parsed = JSON.parse(raw)
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
