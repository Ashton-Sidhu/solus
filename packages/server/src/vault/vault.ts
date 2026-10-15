import { join } from 'node:path'
import type { z } from 'zod'
import type { Integration } from '@solus/contracts/integration-types'
import { oauthTokenSchema, type OAuthToken } from '@solus/contracts/integrations/oauth-protocol'
import { parseUserKey } from '@solus/contracts/user'
import {
  VAULT_CREDENTIAL_PATH,
  VAULT_READ_PATH,
  mcpDeliverySchema,
  typesafeDeliverySchema,
  vaultCredentialHeldBodySchema,
  vaultUploadResponseSchema,
  type CredentialRef,
  type McpDelivery,
  type McpRef,
  type ProviderRef,
  type TypesafeRef,
  type UploadMaterial,
  type VaultDelivery,
  type VaultProvider,
  type VaultReadRequest,
  type VaultUploadRequest,
} from '@solus/contracts/vault'
import { isApiMode } from '../host/api-mode'
import { hostCategory } from '../host/host-category'
import { currentHostUser, isHostUserKey } from '../host/host-user'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore, type SecretStore } from '../platform/secrets'
import { currentPersonKey } from './acting-scope'
import { accountReads, type AccountReads } from './account-reads'

/**
 * The vault (docs/plans/access-model.md §2.6, docs/plans/cloud-vault.md §2.5): the
 * one module that holds and reads a person's credentials. A caller names a person
 * and a credential ref (`@solus/contracts/vault`); the vault decides where the
 * credential is, and the location rule is written here once
 * (`credentialLocationOf`): signed in means the account.
 *
 * - The host's user before this host is linked to their account: this host's store.
 * - The host's user once linked, and every member: their account, read with their
 *   delegated token through `POST /v1/vault/read`.
 * - A guest: nothing (D1).
 *
 * An MCP connection also has a host copy while the reconcile has not moved it into
 * the account yet (a sign-in made on this host); the host reads that copy until then.
 *
 * Refresh stays with the code that speaks the protocol on the host (Google,
 * Atlassian, MCP OAuth): it reads here, refreshes, and saves here. In the account,
 * the cloud refreshes.
 *
 * Not here: seat logins, delegations, ticket and signing keys, uplink tokens.
 * They are the host's infrastructure, not a person's credentials.
 */

const log = createLogger('main', 'vault')

export type { CredentialRef }

/** The host keeps an MCP credential by integration; the account by the server's address. */
export type McpCredentialRef = McpRef & { integrationId: string }

export function mcpCredentialRef(integration: Pick<Integration, 'id' | 'url'>): McpCredentialRef {
  return { kind: 'mcp', integrationId: integration.id, serverUrl: integration.url }
}

export const TYPESAFE_REF: TypesafeRef = { kind: 'typesafe' }

/** Raised when the OS keyring is unavailable; we never write a token in
 *  plaintext. Shared by every provider that stores a credential. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('Secure storage is unavailable on this system, so the token cannot be saved safely.')
    this.name = 'EncryptionUnavailableError'
  }
}

// ── The location rule ───────────────────────────────────────────────────────

export type CredentialLocation = { kind: 'host' } | { kind: 'account'; accountId: string } | { kind: 'none' }

/**
 * Where a person's credentials are. The host's own work (null) uses this host's
 * store; the Solus API has none. An MCP connection of the host's own work does not
 * exist (`hasMcpCredentials`).
 */
/** The person is the owner of this machine: its host user, on a host that is somebody's machine (not a managed host or the Solus API). */
export function isMachineOwner(personKey: string | null): boolean {
  return personKey !== null && !isApiMode() && hostCategory() !== 'managed' && isHostUserKey(personKey)
}

export function credentialLocationOf(personKey: string | null): CredentialLocation {
  if (personKey === null) return isApiMode() ? { kind: 'none' } : { kind: 'host' }
  // The host's user: this machine's store until the host is linked to their account.
  if (isMachineOwner(personKey)) {
    const account = currentHostUser()?.account
    return account ? { kind: 'account', accountId: account.accountId } : { kind: 'host' }
  }
  const person = parseUserKey(personKey)
  return person.kind === 'account' ? { kind: 'account', accountId: person.accountId } : { kind: 'none' }
}

/** The current person's logins are not this host's to change: they are in their account, or they have none here. */
export function usesAccountIntegration(): boolean {
  return credentialLocationOf(currentPersonKey()).kind !== 'host'
}

// ── Reads of a person's account ─────────────────────────────────────────────

/**
 * A person's credential read where the account plane runs in this process: the
 * Solus API inside solus-cloud reads its vault there, with no request and no
 * delegation. It answers what `POST /v1/vault/read` would, or null when the person
 * has no usable connection.
 */
export type AccountCredentialSource = (userId: string, ref: CredentialRef) => Promise<VaultDelivery | null>

let accountCredentialSource: AccountCredentialSource | null = null

/** Install the in-process read of a person's vault; null removes it. */
export function useAccountCredentialSource(source: AccountCredentialSource | null): void {
  accountCredentialSource = source
}

/** A cached MCP token with less than this left is read again before use. */
const RENEWAL_MARGIN_MS = 60_000

/** An MCP credential read from the person's account (cloud-vault.md §2.3). */
export type CloudCredentialRead =
  | { kind: 'ok'; delivery: McpDelivery }
  /** The account holds no connection for this person and server: the person signs in. */
  | { kind: 'not-connected' }
  /** The cloud's refresh was refused: the person signs in again. */
  | { kind: 'reconnect-required' }
  /** This host cannot ask: unlinked, or no delegation for the person. */
  | { kind: 'no-executor' }
  | { kind: 'unreachable' }

export type CloudCredentialUpload =
  | { kind: 'uploaded'; version: number }
  /** The account already holds one: it wins. */
  | { kind: 'held'; currentVersion: number | null }
  /** The cloud could not prove the material works (422): the host keeps its copy. */
  | { kind: 'refused' }
  | { kind: 'no-executor' }
  | { kind: 'unreachable' }

/** The account's answer for an MCP connection. When the cloud does not answer, a token still in the cache is `cached`. */
export type AccountCredentialRead = CloudCredentialRead | { kind: 'cached'; delivery: McpDelivery }

/** What the vault has for a person's MCP connection. */
export type McpCredential =
  /** A pasted key or an OAuth token this host holds. The caller refreshes an OAuth token when due and saves the new one. */
  | { location: 'host'; token: OAuthToken }
  | { location: 'account'; read: AccountCredentialRead }

type AccountCall = { kind: 'response'; response: Response } | { kind: 'no-executor' } | { kind: 'unreachable' }

// ── The host's store ────────────────────────────────────────────────────────

const PROVIDER_HOST_KEYS = {
  github: 'github-oauth',
  google: 'google-oauth',
  atlassian: 'atlassian-oauth',
} satisfies Record<VaultProvider, string>
const TYPESAFE_HOST_KEY = 'typesafe'

function hostKeyOf(ref: ProviderRef | TypesafeRef): string {
  return ref.kind === 'typesafe' ? TYPESAFE_HOST_KEY : PROVIDER_HOST_KEYS[ref.provider]
}

/** `integration-token-<integrationId>-<person>`; the person's key is encoded so it is a safe file name. */
function mcpHostKey(integrationId: string, personKey: string): string {
  return `integration-token-${integrationId}-${Buffer.from(personKey).toString('base64url')}`
}

/** The ref as the cloud reads it: an MCP ref names the server's address alone. */
function cloudRefOf(ref: ProviderRef | TypesafeRef | McpCredentialRef): CredentialRef {
  return ref.kind === 'mcp' ? { kind: 'mcp', serverUrl: ref.serverUrl } : ref
}

/** The host's own GitHub login, read from the secret store directly: what `solus git-credential` serves, a process with no person. */
export function readHostCredential<T>(provider: VaultProvider, schema: z.ZodType<T>): T | null {
  const key = PROVIDER_HOST_KEYS[provider]
  return secretStore().loadJson(key, join(dataDir(), `${key}.bin`), schema)
}

export interface VaultDeps {
  /** Reads of a person's account; the reads this process installed by default. */
  reads?: Pick<AccountReads, 'fetch'>
  /** The host secret store; a test passes its own. */
  secrets?: SecretStore
  now?: () => number
}

export class Vault {
  /** MCP tokens the account delivered, by person and server, until a minute before they expire. */
  private readonly cache = new Map<string, McpDelivery>()
  private readonly reading = new Map<string, Promise<CloudCredentialRead>>()

  constructor(private readonly deps: VaultDeps = {}) {}

  /** The person's credential where the vault keeps it; null when they have none there. */
  read<T>(personKey: string | null, ref: ProviderRef | TypesafeRef, schema: z.ZodType<T>): Promise<T | null>
  read(personKey: string | null, ref: McpCredentialRef): Promise<McpCredential | null>
  async read<T>(personKey: string | null, ref: ProviderRef | TypesafeRef | McpCredentialRef, schema?: z.ZodType<T>): Promise<T | McpCredential | null> {
    if (ref.kind === 'mcp') return this.readMcp(personKey, ref)
    if (!schema) throw new Error('A provider credential is read with its schema.')
    return this.readLogin(personKey, ref, schema)
  }

  /**
   * Keeps a credential made on this host. A login (GitHub, Google, Atlassian,
   * TypeSafe) is saved only where the host keeps it; an MCP sign-in is saved on
   * the host for the person, and for a person with an account the reconcile moves
   * it into their account.
   */
  save<T>(personKey: string | null, ref: ProviderRef | TypesafeRef, value: T): void
  save(personKey: string | null, ref: McpCredentialRef, token: OAuthToken): void
  save<T>(personKey: string | null, ref: ProviderRef | TypesafeRef | McpCredentialRef, value: T | OAuthToken): void {
    if (ref.kind !== 'mcp') {
      if (credentialLocationOf(personKey).kind !== 'host') throw new Error('Manage this connection on the account website.')
      this.saveHost(hostKeyOf(ref), value)
      return
    }
    if (!hasMcpCredentials(personKey)) throw new Error('Only a person who is not a guest connects an MCP server.')
    this.saveHost(mcpHostKey(ref.integrationId, personKey), value)
  }

  /**
   * Removes what this host holds. For an MCP connection, that is the host's
   * token and any token cached from the account; the removed host token is
   * returned so the caller can revoke it.
   */
  remove(personKey: string | null, ref: ProviderRef | TypesafeRef): void
  remove(personKey: string | null, ref: McpCredentialRef): OAuthToken | null
  remove(personKey: string | null, ref: ProviderRef | TypesafeRef | McpCredentialRef): OAuthToken | null | void {
    if (ref.kind !== 'mcp') {
      if (credentialLocationOf(personKey).kind !== 'host') throw new Error('Disconnect this account on the account website.')
      this.removeHost(hostKeyOf(ref))
      return
    }
    if (!hasMcpCredentials(personKey)) return null
    this.forget(personKey, ref)
    const key = mcpHostKey(ref.integrationId, personKey)
    const token = this.loadHost(key, oauthTokenSchema)
    this.removeHost(key)
    return token
  }

  /**
   * Link and unlink: the person's key changed. Their MCP tokens on this host
   * move to the new key; a token the new key already holds wins, and the old one
   * goes either way. Never throws.
   */
  move(fromKey: string, toKey: string, integrationIds: string[]): void {
    for (const integrationId of integrationIds) {
      try {
        const token = this.loadHost(mcpHostKey(integrationId, fromKey), oauthTokenSchema)
        if (token && !this.loadHost(mcpHostKey(integrationId, toKey), oauthTokenSchema)) this.saveHost(mcpHostKey(integrationId, toKey), token)
        this.removeHost(mcpHostKey(integrationId, fromKey))
      } catch (error) {
        // The row moved: without its token it reads as not connected, and the person signs in again.
        log.warn('integration_token_move_failed', { integrationId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /**
   * Link (cloud-vault.md §2.5): the host's user now has an account, so this host
   * keeps no login of theirs. Their TypeSafe key moves into the account, where a
   * key the account holds already wins; GitHub, Google, and Atlassian are made
   * again on the website, since a token belongs to the client that issued it. Their
   * MCP connections move by the reconcile. A key the cloud did not take stays,
   * unread, until the next try (the next delegation) or the unlink.
   */
  async settleLinked(personKey: string): Promise<void> {
    for (const provider of Object.keys(PROVIDER_HOST_KEYS) as VaultProvider[]) this.removeHost(PROVIDER_HOST_KEYS[provider])
    const held = this.loadHost(TYPESAFE_HOST_KEY, typesafeDeliverySchema)
    if (!held) return
    const result = await this.upload(personKey, TYPESAFE_REF, { kind: 'key', key: held.key }, null)
    if (result.kind !== 'uploaded' && result.kind !== 'held') {
      log.info('typesafe_key_kept_until_upload', { reason: result.kind })
      return
    }
    this.removeHost(TYPESAFE_HOST_KEY)
    log.info('typesafe_key_moved_to_account', { outcome: result.kind })
  }

  /**
   * Unlink (cloud-vault.md §2.5): this host keeps nothing for the person who was
   * its user. Their logins, a key that never reached the account, their MCP tokens
   * in `integrationIds`, and every token the account delivered go.
   */
  forgetPerson(personKey: string, integrationIds: string[]): void {
    for (const key of [...Object.values(PROVIDER_HOST_KEYS), TYPESAFE_HOST_KEY]) this.removeHost(key)
    for (const integrationId of integrationIds) this.removeHost(mcpHostKey(integrationId, personKey))
    this.forgetAll()
  }

  /**
   * An executor's upload into the person's account (cloud-vault.md §2.2): once, with
   * `expectedVersion: null`, so a connection the account holds already wins.
   */
  async upload(personKey: string, ref: McpCredentialRef | TypesafeRef, material: UploadMaterial, label: string | null): Promise<CloudCredentialUpload> {
    const body: VaultUploadRequest = { ref: cloudRefOf(ref), material, expectedVersion: null, label }
    const call = await this.callAccount(personKey, 'PUT', VAULT_CREDENTIAL_PATH, body)
    if (call.kind !== 'response') return call
    const response = call.response
    const answer: unknown = await response.json().catch(() => null)
    if (response.status === 201 || response.status === 200) {
      const parsed = vaultUploadResponseSchema.safeParse(answer)
      if (parsed.success) {
        log.info('vault_credential_uploaded', { personKey, kind: ref.kind, version: parsed.data.version })
        return { kind: 'uploaded', version: parsed.data.version }
      }
    }
    if (response.status === 409) {
      const parsed = vaultCredentialHeldBodySchema.safeParse(answer)
      return { kind: 'held', currentVersion: parsed.success ? parsed.data.currentVersion : null }
    }
    if (response.status === 422) return { kind: 'refused' }
    log.warn('vault_credential_upload_failed', { personKey, kind: ref.kind, status: response.status })
    return { kind: 'unreachable' }
  }

  /** The server refused a token the account delivered: the next call reads the account again. */
  forget(personKey: string, ref: McpCredentialRef): void {
    this.cache.delete(cacheKey(personKey, ref.serverUrl))
  }

  /** A delegation ended (sign-out, removal): no credential it brought may be used again; the next call reads the account. */
  forgetAll(): void {
    this.cache.clear()
  }

  // ── Logins: GitHub, Google, Atlassian, TypeSafe ──

  private async readLogin<T>(personKey: string | null, ref: ProviderRef | TypesafeRef, schema: z.ZodType<T>): Promise<T | null> {
    const location = credentialLocationOf(personKey)
    if (location.kind === 'none') return null
    if (location.kind === 'host') return this.loadHost(hostKeyOf(ref), schema)
    if (accountCredentialSource) {
      const delivery = await accountCredentialSource(location.accountId, ref)
      return delivery ? schema.parse(delivery) : null
    }
    // The person's connection, read with their delegated token (ADR 0001 §2.2 rule 7).
    const body: VaultReadRequest = { ref }
    const response = await this.reads().fetch(location.accountId, null, VAULT_READ_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!(response instanceof Response)) throw new Error(response.message)
    if (response.status === 404) return null
    if (response.status === 409) throw new Error('Your account connection needs you to sign in again. Open Connections on the account website.')
    if (!response.ok) throw new Error('Your account connection is unavailable. Open Connections on the account website.')
    return schema.parse(await response.json())
  }

  // ── MCP ──

  private async readMcp(personKey: string | null, ref: McpCredentialRef): Promise<McpCredential | null> {
    if (!hasMcpCredentials(personKey)) return null
    const location = credentialLocationOf(personKey)
    if (location.kind === 'none') return null
    // The host's user before the link; or, for a person with an account, a sign-in made here that the reconcile has not moved yet.
    const token = this.loadHost(mcpHostKey(ref.integrationId, personKey), oauthTokenSchema)
    if (token) return { location: 'host', token }
    if (location.kind === 'host') return null
    const read = await this.readAccountMcp(personKey, ref.serverUrl)
    if (read.kind === 'unreachable') {
      const cached = this.cache.get(cacheKey(personKey, ref.serverUrl))
      if (cached && (cached.expiresAt === null || cached.expiresAt > this.now())) return { location: 'account', read: { kind: 'cached', delivery: cached } }
    }
    return { location: 'account', read }
  }

  /** The cached token while it lasts, else the account's answer; one request per person and server at a time. */
  private readAccountMcp(personKey: string, serverUrl: string): Promise<CloudCredentialRead> {
    const key = cacheKey(personKey, serverUrl)
    const cached = this.cache.get(key)
    if (cached && (cached.expiresAt === null || cached.expiresAt - this.now() > RENEWAL_MARGIN_MS)) {
      return Promise.resolve({ kind: 'ok', delivery: cached })
    }
    const pending = this.reading.get(key)
    if (pending) return pending
    const read = this.fetchDelivery(personKey, serverUrl).finally(() => this.reading.delete(key))
    this.reading.set(key, read)
    return read
  }

  private async fetchDelivery(personKey: string, serverUrl: string): Promise<CloudCredentialRead> {
    const call = await this.callAccount(personKey, 'POST', VAULT_READ_PATH, { ref: { kind: 'mcp', serverUrl } })
    if (call.kind !== 'response') return call
    const response = call.response
    const body: unknown = await response.json().catch(() => null)
    const key = cacheKey(personKey, serverUrl)
    if (response.ok) {
      const parsed = mcpDeliverySchema.safeParse(body)
      if (parsed.success) {
        this.cache.set(key, parsed.data)
        return { kind: 'ok', delivery: parsed.data }
      }
      log.warn('integration_credential_unreadable', { personKey })
      return { kind: 'unreachable' }
    }
    if (response.status === 404) {
      this.cache.delete(key)
      return { kind: 'not-connected' }
    }
    if (response.status === 409) {
      this.cache.delete(key)
      return { kind: 'reconnect-required' }
    }
    log.warn('integration_credential_read_failed', { personKey, status: response.status })
    return { kind: 'unreachable' }
  }

  /** One executor call to the person's vault, with their delegated token. */
  private async callAccount(personKey: string, method: 'POST' | 'PUT', path: string, body: VaultReadRequest | VaultUploadRequest): Promise<AccountCall> {
    const location = credentialLocationOf(personKey)
    // A person with no account (the host's user before the link) has no account to ask.
    if (location.kind !== 'account') return { kind: 'no-executor' }
    const response = await this.reads().fetch(location.accountId, null, path, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (response instanceof Response) return { kind: 'response', response }
    if (response.refused !== 'UNREACHABLE') return { kind: 'no-executor' }
    log.warn('vault_cloud_unreachable', { error: response.message })
    return { kind: 'unreachable' }
  }

  // ── The host secret store ──

  private secrets(): SecretStore {
    return this.deps.secrets ?? secretStore()
  }

  private reads(): Pick<AccountReads, 'fetch'> {
    return this.deps.reads ?? accountReads()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private loadHost<T>(key: string, schema: z.ZodType<T>): T | null {
    return this.secrets().loadJson(key, join(dataDir(), `${key}.bin`), schema)
  }

  private saveHost<T>(key: string, value: T): void {
    const store = this.secrets()
    if (!store.canSave()) throw new EncryptionUnavailableError()
    store.saveJson(key, join(dataDir(), `${key}.bin`), value)
  }

  private removeHost(key: string): void {
    try {
      this.secrets().remove(key, join(dataDir(), `${key}.bin`))
    } catch (error) {
      log.warn('vault_secret_remove_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** A guest and the host's own work have no MCP credentials (docs/plans/access-model.md D1). */
function hasMcpCredentials(personKey: string | null): personKey is string {
  return personKey !== null && parseUserKey(personKey).kind !== 'guest'
}

function cacheKey(personKey: string, serverUrl: string): string {
  return `${personKey}\u0000${serverUrl}`
}

// ── This process's vault ────────────────────────────────────────────────────

let installed: Vault | null = null

/** Installed by the server at boot; null removes it. */
export function useVault(next: Vault | null): void {
  installed = next
}

/** The vault this process installed; before boot, one with the process's account reads. */
export function vault(): Vault {
  installed ??= new Vault()
  return installed
}
