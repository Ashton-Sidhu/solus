import { AsyncLocalStorage } from 'node:async_hooks'
import { useActingEnv } from '../cli-env'
import { createLogger } from '../logger'
import type { ActingIdentity } from '../execution/seats/acting-identity'

const log = createLogger('main', 'acting-scope')

/**
 * Who the current call acts as (plans/019-acting-identity.md). The scope is set
 * once at the edge where work starts — an RPC from its actor, an agent tool call
 * or a turn from the turn's actor, an automation from its creator, a timer from
 * whoever it works for — and everything below it reads it: every process the
 * server starts takes its environment from `identity`, and every account
 * connection (GitHub, Google, Atlassian) is read as `credentialUserId`.
 *
 * A missing scope is an error, never the host. Work that is the host's own says
 * so with the host identity.
 */
export interface ActingScope {
  readonly identity: ActingIdentity
  /** Whose account connections the call reads; null for the host's own store. */
  readonly credentialUserId: string | null
}

export const NO_ACTING_SCOPE_CODE = 'NO_ACTING_SCOPE'

export class NoActingScopeError extends Error {
  readonly code = NO_ACTING_SCOPE_CODE

  constructor(what: string) {
    super(`Solus started ${what} with no acting identity. This is a bug: report it with the server log.`)
    this.name = 'NoActingScopeError'
  }
}

const storage = new AsyncLocalStorage<ActingScope>()

export function withActingScope<T>(scope: ActingScope, fn: () => T): T {
  return storage.run(scope, fn)
}

/**
 * Tests only (`actAsHostForTests`): the scope a call with none uses, for the
 * rest of this test process. Production never sets it, so there a missing
 * scope is always an error. (Bun loses an async scope set while a test file
 * registers its tests after a top-level await, so tests cannot set one there.)
 */
let defaultScopeForTests: ActingScope | null = null

export function useDefaultActingScopeForTests(scope: ActingScope | null): void {
  defaultScopeForTests = scope
}

/** Turns a person into their scope; installed by the server with its acting identities. */
export interface ActingScopeSource {
  /** A person's scope by user key, or the host's own for null. */
  scopeForUser(userKey: string | null): ActingScope
}

let source: ActingScopeSource | null = null

export function useActingScopeSource(next: ActingScopeSource | null): void {
  source = next
}

/**
 * Runs `fn` as a person named only by their user key — a task's owner, an
 * automation's creator — or as the host for null. For code that holds a key and
 * no actor, such as the data layer.
 */
export function withUserScope<T>(userKey: string | null, fn: () => T): T {
  if (!source) throw new Error('Acting identities are not installed on this server.')
  return withActingScope(source.scopeForUser(userKey), fn)
}

/** The scope a later callback must run in, captured where the work starts. Null outside any scope. */
export function captureActingScope(): ActingScope | null {
  return storage.getStore() ?? defaultScopeForTests
}

/** The current scope, or `NoActingScopeError` naming what needed it. */
export function requireActingScope(what: string): ActingScope {
  const scope = storage.getStore() ?? defaultScopeForTests
  if (scope) return scope
  const error = new NoActingScopeError(what)
  log.error('acting_scope_missing', { what, stack: error.stack })
  throw error
}

/** The identity every process started below this call acts as. */
export function currentIdentity(what = 'a process'): ActingIdentity {
  return requireActingScope(what).identity
}

/** The person whose account connections the current call reads; null for the host's own. */
export function currentCredentialUserId(): string | null {
  return requireActingScope('an account connection read').credentialUserId
}

// Every `getCliEnv` caller takes the environment of the identity acting now.
useActingEnv((extraEnv) => currentIdentity().envSync(extraEnv))
