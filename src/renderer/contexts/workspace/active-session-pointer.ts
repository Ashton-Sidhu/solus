import type { AgentId } from '../../../shared/types'
import { localApi } from '@client-core/local-api'
import { z } from 'zod'

// The schema validates everything the consumer reads. `serverId` is required:
// a handoff is a session ref crossing the client, so it names its host. A
// record without one (or from a corrupt write) fails decode and is deleted —
// the handoff is 30-second best-effort UX, so "resend" beats "guess a host".
const sessionHandoffSchema = z.object({
  sessionId: z.string(),
  serverId: z.string(),
  // SAFETY: Writer and reader are windows of the same build, so the value is
  // always a legal AgentId; validating the union here would only drift from
  // the type as agents are added.
  provider: z.string().min(1).transform((value) => value as AgentId),
  cwd: z.string().catch(''),
  title: z.string().nullable().catch(null),
  target: z.enum(['pill', 'editor']),
  updatedAt: z.number(),
})

// Explicit "continue in the other mode" (⌥⇧E) handoff. Both Electron windows
// share one localStorage; tab stores stay per-window, and this one-shot key
// lets the target window attach only the session the user explicitly sent.

export interface SessionHandoff {
  sessionId: string
  /** The host the session runs on — the target window must not guess it. */
  serverId: string
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
    return localApi.getPlatform() !== 'web'
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
    let raw: string | null = null
    try {
      raw = localStorage.getItem(HANDOFF_KEY)
    } catch {}
    if (!raw) return
    let parsed: SessionHandoff | null = null
    try {
      const decoded = sessionHandoffSchema.safeParse(JSON.parse(raw))
      if (decoded.success) parsed = decoded.data
    } catch {}
    try {
      if (!parsed) {
        // Delete-and-miss: an undecodable record would otherwise re-fail on
        // every storage event for the lifetime of both windows.
        localStorage.removeItem(HANDOFF_KEY)
        return
      }
      if (parsed.target !== target) return
      localStorage.removeItem(HANDOFF_KEY)
    } catch {}
    if (!parsed || parsed.target !== target) return
    if (Date.now() - parsed.updatedAt > HANDOFF_TTL_MS) return
    onSession(parsed)
  }
  consume()
  const onStorage = (e: StorageEvent) => {
    if (e.key === HANDOFF_KEY && e.newValue) consume()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
