import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Whose provider credential (GitHub, Google, Atlassian) a call acts with
 * (docs/plans/cloud-service-model.md §22). The scope is set once at the edge —
 * an RPC dispatch from its principal, an agent tool call from the turn's actor,
 * a task sync from the task's owner — and every accessor below it reads the
 * scoped person's credential. `null` means the host's own: the signed-out host,
 * the host's owner, and headless work nobody in particular asked for.
 */

interface CredentialScope {
  userId: string
}

const storage = new AsyncLocalStorage<CredentialScope | null>()

export function withCredentialScope<T>(userId: string | null, fn: () => T): T {
  return storage.run(userId === null ? null : { userId }, fn)
}

/** The person whose credential the current call acts with; null for the host's own. */
export function currentCredentialUserId(): string | null {
  return storage.getStore()?.userId ?? null
}
