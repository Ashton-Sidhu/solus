import { SvelteMap } from 'svelte/reactivity'
import type { SessionMeta } from '../../../../shared/types'
import { resolveSessionMetaRef } from '@client-core/session-meta'

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

  /** Resolve every id not already known or in flight. Safe to call on each
   *  render pass; it de-duplicates. */
  ensure(sessionIds: (string | null)[]): void {
    for (const id of sessionIds) {
      if (!id || this.#labels.has(id) || this.#pending.has(id)) continue
      this.#pending.add(id)
      void resolveSessionMetaRef({ sessionId: id })
        .then((meta) => {
          const label = sessionMetaLabel(meta)
          if (label) this.#labels.set(id, label)
        })
        .catch(() => {})
        .finally(() => this.#pending.delete(id))
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
