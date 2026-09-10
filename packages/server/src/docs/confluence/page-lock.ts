import type { DocRef } from '@solus/contracts/docs'

const pending = new Map<string, Promise<unknown>>()

/** A local comment create must not race a page write built before its marker existed. */
export async function withConfluencePage<T>(ref: DocRef, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([ref.externalKey.split('/')[0], ref.externalId])
  const previous = pending.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(action)
  pending.set(key, next)
  try { return await next } finally { if (pending.get(key) === next) pending.delete(key) }
}
