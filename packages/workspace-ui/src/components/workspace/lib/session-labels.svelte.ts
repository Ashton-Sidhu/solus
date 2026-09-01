import { SvelteMap } from 'svelte/reactivity'
import type { SessionMeta } from '@solus/contracts/types'
import { readSessionMeta } from '@solus/client-core/session-meta'

export interface SessionLabelRef {
  sessionId: string | null
  /** The host that owns the session. A row without one keeps its fallback
   *  label — the index is never probed across hosts for a name. */
  serverId: string | null
}

/**
 * Names for the sessions the ledger's artifacts came from.
 *
 * A row only holds a session *id*; the readable name lives in the session
 * index. Ids are stable and a session's name barely moves under an open ledger,
 * so each id is looked up once and kept — 400 rows resolve at most 400 index
 * hits for the whole visit, and re-filtering costs none.
 */
export class SessionLabels {
  #labels = new SvelteMap<string, string>()
  #pending = new Set<string>()

  /** The name if it is known. Callers render their own fallback — the chip
   *  should not wait on the index to appear. */
  get(sessionId: string | null): string | null {
    return sessionId ? (this.#labels.get(sessionId) ?? null) : null
  }

  /** Resolve every ref not already known or in flight. Safe to call on each
   *  render pass; it de-duplicates. */
  ensure(refs: SessionLabelRef[]): void {
    for (const { sessionId, serverId } of refs) {
      if (!sessionId || !serverId || this.#labels.has(sessionId) || this.#pending.has(sessionId)) continue
      this.#pending.add(sessionId)
      void readSessionMeta(serverId, sessionId)
        .then((meta) => {
          const label = sessionMetaLabel(meta)
          if (label) this.#labels.set(sessionId, label)
        })
        .catch(() => {})
        .finally(() => this.#pending.delete(sessionId))
    }
  }
}

/** The same precedence every session list in Solus uses: the name a person gave
 *  it, then the generated slug, then the words it opened with. */
export function sessionMetaLabel(meta: SessionMeta | null): string {
  if (!meta) return ''
  const named = meta.customTitle?.trim() || meta.slug?.trim()
  if (named) return named
  const opening = meta.firstMessage?.replace(/\s+/g, ' ').trim() ?? ''
  return opening.length > 48 ? `${opening.slice(0, 47)}…` : opening
}
