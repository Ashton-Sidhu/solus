import type { AgentId } from '../../../shared/types'

// Explicit "continue in the other mode" (⌥⇧E) handoff. Both Electron windows
// share one localStorage; tab stores stay per-window, and this one-shot key
// lets the target window attach only the session the user explicitly sent.

export interface SessionHandoff {
  sessionId: string
  provider: AgentId
  cwd: string
  title: string | null
  target: 'pill' | 'editor'
  updatedAt: number
}

const HANDOFF_KEY = 'solus-session-handoff'
const HANDOFF_TTL_MS = 30_000

function isElectron(): boolean {
  try {
    return window.solus.getPlatform() !== 'web'
  } catch {
    return false
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
