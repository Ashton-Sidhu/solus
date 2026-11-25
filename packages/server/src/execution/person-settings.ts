import { z } from 'zod'
import {
  PERSONAL_SETTING_KEYS,
  executionPreferencesOf,
  knownPersonalSettings,
  type ExecutionPreferences,
  type HostPersonalSettings,
  type PersonalSettingKey,
  type PersonalSettingsDocument,
  type PersonalSettingsPatch,
  type PersonalSettingsPatchResult,
  type PersonalSettingsSource,
} from '@solus/contracts/settings'
import { MANAGED_SESSION_SETTING_KEYS } from '@solus/contracts/policy'
import { hostPolicies } from '../host/policy/host-policy-store'
import { LOCAL_ORGANIZATION_ID } from '../host/machine-kind'
import { createLogger } from '../logger'
import { requireActingScope } from '../vault/acting-scope'
import type { AccountReadRefusal } from '../vault/account-reads'
import { listPersonalDocuments, writePersonalDocument } from '../data/personal-documents/personal-documents'

const log = createLogger('SessionRuntime', 'person-settings.ts')

/**
 * This host's copy of each person's settings, by person key (`ownerKeyOf`;
 * docs/adr/0007-personal-settings-source.md, docs/plans/personal-settings-source.md).
 * It is the one place the host reads a person's settings for work a person asks
 * for now: a prompt, a retry, a provider switch, a worktree, a review guide.
 *
 * Signed out, the copy is the source: the person's clients read and write it
 * here (`source: 'host'`). Signed in, the account is the source: the host pulls it
 * with its token for the person (`source: 'account'`), at boot, every
 * `PERSONAL_SETTINGS_PULL_INTERVAL_MS`, and when a client says that it changed.
 * When the host holds no token for the person, their client writes the account's
 * copy here. Either way the copy is in the database (`personal_documents`), so it
 * survives a restart and a cloud that does not answer. Every copy is loaded at
 * boot, so the readers stay synchronous.
 *
 * Work that nobody asks for now reads what its run captured (the session's
 * stored preferences, an automation's snapshot), not this copy.
 */

/** How often the host pulls the settings of each person it holds a token for, as the agent profile (plans/020 §4). */
export const PERSONAL_SETTINGS_PULL_INTERVAL_MS = 5 * 60_000

/** A host is the home of each person who uses it (docs/plans/person-state.md §3). */
const SCOPE = LOCAL_ORGANIZATION_ID

interface Copy {
  settings: PersonalSettingsDocument
  source: PersonalSettingsSource
  accountRevision: number | null
  updatedAt: number
}

/** The person's account, as a pull reads it. Installed at boot; absent on a host that is never linked. */
export interface PersonSettingsAccount {
  /** The account of the person when this host holds a token that reads it; null when it holds none. */
  userFor(personKey: string): string | null
  /** One read of `ACCOUNT_SETTINGS_PATH` as the person (`AccountReads.fetch`). */
  read(userId: string): Promise<Response | AccountReadRefusal>
}

const copies = new Map<string, Copy>()
/**
 * Each person's Sync settings switch on this host (docs/plans/settings-sync-hosts.md),
 * by person key. A person with no entry has it on.
 */
const syncSwitches = new Map<string, boolean>()
/** The last write of each person, so two writes reach the database in the order they were made. */
const writes = new Map<string, Promise<void>>()
let account: PersonSettingsAccount | null = null
let now: () => number = Date.now

/**
 * A settings document as a client, the account, or this host's database sent it:
 * any object. Its keys are read one at a time afterwards (`knownPersonalSettings`),
 * so a key that a newer client or the cloud knows and this host does not never
 * refuses the read.
 */
// SAFETY: only an object passes, and every reader of the result reads each key with that key's own schema.
const sentSettingsSchema = z.looseObject({}).transform((sent) => sent as PersonalSettingsDocument)

/** The account's answer as a host reads it: the envelope is strict, the document lenient. */
const accountAnswerSchema = z.object({
  revision: z.number().int().positive().nullable(),
  settings: sentSettingsSchema,
})

/** A client's change, read leniently: a key or value this host does not know is named, never a refusal. */
/** The stored switch: `{ "syncSettings": false }`. Anything else reads as on, the default. */
const syncSwitchSchema = z.object({ syncSettings: z.boolean() })

const patchSchema = z.object({
  set: sentSettingsSchema.default({}),
  reset: z.array(z.string().max(200)).max(1_000).default([]),
})

function isPersonalSettingKey(key: string): key is PersonalSettingKey {
  return PERSONAL_SETTING_KEYS.some((known) => known === key)
}

/** Installed by the server with its account reads; null forgets it (tests). */
export function usePersonSettingsAccount(next: PersonSettingsAccount | null): void {
  account = next
}

/** Reads every person's copy from the database. Called once at boot, before the first request. */
export async function loadPersonSettings(): Promise<void> {
  copies.clear()
  syncSwitches.clear()
  for (const row of await listPersonalDocuments(SCOPE, 'settings-sync')) {
    syncSwitches.set(row.personKey, readSyncSwitch(row.content))
  }
  for (const row of await listPersonalDocuments(SCOPE, 'settings')) {
    const { settings, ignored } = knownPersonalSettings(parseContent(row.content))
    // A key that an older or a newer version stored: left out, the others stay.
    if (ignored.length) log.info('person_settings_stored_keys_ignored', { keys: ignored })
    copies.set(row.personKey, { settings, source: row.source, accountRevision: row.accountRevision, updatedAt: row.updatedAt })
  }
}

function readSyncSwitch(content: string): boolean {
  try {
    const parsed = syncSwitchSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data.syncSettings : true
  } catch {
    return true
  }
}

function parseContent(content: string): PersonalSettingsDocument {
  try {
    const parsed = sentSettingsSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function actingPersonKey(): string {
  const { personKey } = requireActingScope("a person's settings")
  if (personKey === null) throw new Error('Only a person has settings.')
  return personKey
}

/** The person's copy as a client reads it. */
function snapshotOf(personKey: string): HostPersonalSettings {
  const copy = copies.get(personKey)
  return {
    settings: structuredClone(copy?.settings ?? {}),
    source: copy?.source ?? 'host',
    followsAccount: account?.userFor(personKey) != null,
    accountRevision: copy?.accountRevision ?? null,
    updatedAt: copy?.updatedAt ?? null,
    syncSettings: syncSwitches.get(personKey) ?? true,
  }
}

/** Keeps the copy now, and writes it to the database after the person's earlier writes. */
function store(personKey: string, copy: Copy): Promise<void> {
  copies.set(personKey, copy)
  const write = (writes.get(personKey) ?? Promise.resolve()).then(() => writePersonalDocument(SCOPE, {
    personKey,
    kind: 'settings',
    content: JSON.stringify(copy.settings),
    source: copy.source,
    accountRevision: copy.accountRevision,
    updatedAt: copy.updatedAt,
  }))
  const settled = write.catch((error) => {
    log.error('person_settings_write_failed', { error: error instanceof Error ? error.message : String(error) })
  })
  writes.set(personKey, settled)
  void settled.then(() => { if (writes.get(personKey) === settled) writes.delete(personKey) })
  return write
}

/** `personalSettingsGet`: the copy of the person the current call acts for. */
export function actingPersonalSettings(): HostPersonalSettings {
  return snapshotOf(actingPersonKey())
}

/**
 * `personalSettingsPatch`: changes the copy of the person the current call acts
 * for. The keys this host does not know, or whose value does not pass its schema,
 * are left out and named: a client that is newer than this host never makes a
 * call fail. The copy is now the person's own (`source: 'host'`); a host that
 * follows their account takes the account's copy again at its next pull.
 */
export async function patchActingPersonalSettings(sent: PersonalSettingsPatch | undefined): Promise<PersonalSettingsPatchResult> {
  const personKey = actingPersonKey()
  const parsed = patchSchema.safeParse(sent ?? {})
  const change = parsed.success ? parsed.data : { set: {}, reset: [] }
  const { settings: set, ignored } = knownPersonalSettings(change.set)
  const reset = change.reset.filter(isPersonalSettingKey)
  ignored.push(...change.reset.filter((key) => !isPersonalSettingKey(key)))
  if (!parsed.success) ignored.push('(change)')
  const settings = structuredClone(copies.get(personKey)?.settings ?? {})
  for (const key of reset) delete settings[key]
  Object.assign(settings, set)
  await store(personKey, { settings, source: 'host', accountRevision: null, updatedAt: now() })
  // Only key names are logged: the values are the person's.
  if (ignored.length) log.info('person_settings_keys_ignored', { keys: [...new Set(ignored)].sort(), source: 'client' })
  return { settings: snapshotOf(personKey), ignored: [...new Set(ignored)].sort() }
}

/**
 * `personalSettingsSyncSet`: turns the Sync settings switch of the person the
 * current call acts for on or off on this host. It changes no setting: the
 * person's clients copy and spread the settings (docs/plans/settings-sync-hosts.md).
 */
export async function setActingSettingsSync(sent: boolean | undefined): Promise<HostPersonalSettings> {
  const personKey = actingPersonKey()
  const syncSettings = z.boolean().parse(sent)
  syncSwitches.set(personKey, syncSettings)
  await writePersonalDocument(SCOPE, {
    personKey,
    kind: 'settings-sync',
    content: JSON.stringify({ syncSettings }),
    source: 'host',
    accountRevision: null,
    updatedAt: now(),
  })
  log.info('person_settings_sync_changed', { syncSettings })
  return snapshotOf(personKey)
}

/** `personalSettingsChanged`: the person's account copy changed. The host pulls it now when it can, and answers. */
export async function pullActingPersonalSettings(): Promise<HostPersonalSettings> {
  const personKey = actingPersonKey()
  await pullPersonSettings(personKey)
  return snapshotOf(personKey)
}

/**
 * Reads one person's settings from their account with this host's token for them,
 * and keeps them. Nothing changes when the host holds no token, the cloud does not
 * answer or refuses, or the account has no document yet: the host keeps its copy.
 */
export async function pullPersonSettings(personKey: string): Promise<void> {
  const userId = account?.userFor(personKey) ?? null
  if (!account || !userId) return
  const response = await account.read(userId)
  if (!(response instanceof Response)) {
    log.info('person_settings_pull_skipped', { reason: response.refused })
    return
  }
  if (!response.ok) {
    log.warn('person_settings_pull_refused', { status: response.status })
    return
  }
  const answer = accountAnswerSchema.safeParse(await response.json().catch(() => null))
  if (!answer.success) {
    log.warn('person_settings_pull_unreadable', {})
    return
  }
  // The account has no document: the person never synced one, so the host keeps what it has.
  if (answer.data.revision === null) return
  const { settings, ignored } = knownPersonalSettings(answer.data.settings)
  if (ignored.length) log.info('person_settings_keys_ignored', { keys: ignored, source: 'account' })
  const held = copies.get(personKey)
  if (held?.source === 'account' && held.accountRevision === answer.data.revision && JSON.stringify(held.settings) === JSON.stringify(settings)) return
  log.info('person_settings_pulled', { revision: answer.data.revision })
  await store(personKey, { settings, source: 'account', accountRevision: answer.data.revision, updatedAt: now() })
}

/**
 * Pulls for every person this host keeps settings for, and for `alsoFor` (the
 * host's owner), now and every interval. A person the host holds no token for is
 * skipped. Returns the stop.
 */
export function startPersonSettingsPulls(alsoFor: () => string[], intervalMs = PERSONAL_SETTINGS_PULL_INTERVAL_MS): () => void {
  const sweep = () => {
    for (const personKey of new Set([...copies.keys(), ...alsoFor()])) {
      void pullPersonSettings(personKey).catch((error) => {
        log.info('person_settings_pull_failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }
  }
  sweep()
  const timer = setInterval(sweep, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * The execution preferences of the person the current call acts for, from their
 * copy, with the settings that a policy of the work's organization locks laid over
 * them (plans/030 §6.6). The host's own work has no person, so it gets only the
 * locks. A person with no copy here runs with the built-in defaults.
 */
export function actingPreferences(organizationId: string | null | undefined): ExecutionPreferences {
  const { personKey } = requireActingScope("a person's preferences")
  const own = personKey === null ? {} : executionPreferencesOf(copies.get(personKey)?.settings ?? {})
  return hostPolicies().forWork(organizationId ?? LOCAL_ORGANIZATION_ID).withLocks(own, MANAGED_SESSION_SETTING_KEYS)
}

/** Settles when every write made so far reached the database. */
export async function personSettingsWritten(): Promise<void> {
  await Promise.all(writes.values())
}

/** For tests: a person's copy in memory only, as if their client had written it. */
export function setPersonSettingsForTests(personKey: string, settings: PersonalSettingsDocument): void {
  copies.set(personKey, { settings: structuredClone(settings), source: 'host', accountRevision: null, updatedAt: now() })
}

/** For tests: forget every copy in memory (a restart), and set the clock. */
export function resetPersonSettingsForTests(clock: () => number = Date.now): void {
  copies.clear()
  syncSwitches.clear()
  writes.clear()
  now = clock
}
