import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Whose provider credential (GitHub, Google, Atlassian) a call acts with
 * (docs/plans/cloud-service-model.md §22). The scope is set once at the edge —
 * an RPC dispatch from its principal, an agent tool call from the turn's actor,
 * a task sync from the task's owner — and every accessor below it reads the
 * scoped person's credential. `null` means explicit local mode: the signed-out
 * host and headless work nobody in particular asked for. A signed-in desktop
 * owner has their real account ID, captured before the operation starts.
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
