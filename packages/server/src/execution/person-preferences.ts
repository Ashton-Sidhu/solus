import { knownExecutionPreferences, type ExecutionPreferences, type KnownExecutionPreferences } from '@solus/contracts/settings'
import { MANAGED_SESSION_SETTING_KEYS } from '@solus/contracts/policy'
import { hostPolicies } from '../host/policy/host-policy-store'
import { LOCAL_ORGANIZATION_ID } from '../host/host-category'
import { createLogger } from '../logger'
import { requireActingScope } from '../vault/acting-scope'

const log = createLogger('SessionRuntime', 'person-preferences.ts')

/**
 * This host's copy of each person's execution preferences, by person key
 * (`ownerKeyOf`; docs/plans/host-preferences.md). It is the one place the host
 * reads a person's preferences for work a person asks for now: a prompt, a
 * retry, a provider switch, a worktree, a review guide. A client writes the
 * copy when it connects and when the preferences change; no request carries
 * them.
 *
 * In memory: after a restart, each client writes the copy again when it
 * connects. Until a person's copy arrives, their work runs with the built-in
 * defaults. Work that nobody asks for now reads what its run captured (the
 * session's stored preferences, an automation's snapshot), not this copy.
 */
const copies = new Map<string, ExecutionPreferences>()

/**
 * Replaces the copy of the person the current call acts for. The keys this host does not know, or whose value
 * does not pass its schema, are left out and named: a client that is newer
 * than this host never makes a later call fail.
 */
export function setPersonPreferences(sent: ExecutionPreferences): Pick<KnownExecutionPreferences, 'ignored'> {
  const { personKey } = requireActingScope("a person's preferences")
  if (personKey === null) throw new Error('Only a person has preferences.')
  const { preferences, ignored } = knownExecutionPreferences(sent)
  copies.set(personKey, preferences)
  // Only key names are logged: the values are the person's.
  if (ignored.length) log.info('person_preferences_keys_ignored', { keys: ignored })
  return { ignored }
}

/**
 * The preferences of the person the current call acts for, with the settings
 * that a policy of the work's organization locks laid over them (plans/030
 * §6.6). The host's own work has no person, so it gets only the locks.
 */
export function actingPreferences(organizationId: string | null | undefined): ExecutionPreferences {
  const { personKey } = requireActingScope("a person's preferences")
  const own = personKey === null ? {} : copies.get(personKey) ?? {}
  return hostPolicies().forWork(organizationId ?? LOCAL_ORGANIZATION_ID).withLocks(own, MANAGED_SESSION_SETTING_KEYS)
}

/** For tests: start with no copies. */
export function resetPersonPreferencesForTests(): void {
  copies.clear()
}
