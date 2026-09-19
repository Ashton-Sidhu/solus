import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from '@solus/contracts/types'
import { SEAT_PROVIDERS, type SeatChangedEvent, type SeatProvider, type SeatStatus } from '@solus/contracts/seats'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import {
  CLAUDE_CREDENTIALS_FILE,
  CODEX_AUTH_FILE,
  credentialFiles,
  ensureSeatShims,
  memberSeatDirectory,
  parseCodexAuthJson,
  type SeatStore,
  type TurnSeat,
} from '../seats/seat-manager'
import type { CredentialMaterial } from '../server/uplink/runner-protocol'
import { parseClaudeCredentialSet } from './credential-material'
import { credentialExpiresAt, deleteCredential, putCredential, readCredentialInfo, vaultConfigured, VaultNotConfiguredError } from './vault'

const log = createLogger('main', 'vault-seats')

/**
 * The workspace service's seats (docs/plans/cloud-service-model.md §5): the
 * same surface the handlers and the connector use on a host, backed by the
 * credential vault instead of directories and rows. A relayed login still runs
 * the provider CLI in a seat directory here; once it has written its credential
 * file, the file is taken into the vault and deleted, so nothing readable stays
 * on the service's disk. The service runs no turn, so no seat is ever resolved
 * here; runners lease what this stores.
 *
 * Without `SOLUS_VAULT_KEY` every call answers `VAULT_NOT_CONFIGURED`: the
 * service still boots for organizations that do not use seats.
 */

export interface VaultSeatManagerDeps {
  /** Defaults to `<SOLUS_DATA_DIR>-seats`: where a relayed login runs before its file is taken in. */
  seatsRoot?: string
}

const NO_CREDENTIAL_FILE_MESSAGE = 'Sign-in finished, but the CLI left no credential file: the workspace service must run where the CLI writes a credential file, not the keychain.'

export class VaultSeatManager implements SeatStore {
  readonly seatsRoot: string
  private readonly listeners = new Set<(event: SeatChangedEvent) => void>()
  /** Logins in progress: the one seat state the vault does not hold. */
  private readonly connecting = new Set<string>()

  constructor(deps: VaultSeatManagerDeps = {}) {
    this.seatsRoot = deps.seatsRoot ?? `${solusDir()}-seats`
  }

  onChanged(listener: (event: SeatChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(userId: string): Promise<SeatStatus[]> {
    return Promise.all(SEAT_PROVIDERS.map((provider) => this.status(userId, provider)))
  }

  async status(userId: string, provider: SeatProvider): Promise<SeatStatus> {
    requireVault()
    if (this.connecting.has(seatKey(userId, provider))) return { provider, state: 'connecting', method: 'login', usageCapable: false }
    const info = await readCredentialInfo(userId, provider)
    if (!info) return { provider, state: 'none', usageCapable: false }
    return {
      provider,
      state: 'connected',
      method: info.method,
      connectedAt: info.connectedAt,
      // A pasted Claude token is `user:inference` only; `/usage` cannot read its quota.
      usageCapable: !(provider === 'claude-code' && info.method === 'token'),
    }
  }

  /** The service serves no execution plane; a runner leases the credential for its own turns. */
  resolveForTurn(_seatUserId: string, _provider: AgentId): Promise<TurnSeat | null> {
    return Promise.reject(new Error('The workspace service runs no turns; a runner leases the seat.'))
  }

  connectedSeat(_userId: string, _provider: SeatProvider): TurnSeat | null {
    return null
  }

  homeFor(userId: string, provider: SeatProvider): string {
    requireVault()
    return memberSeatDirectory(this.seatsRoot, userId, provider)
  }

  shimBinDir(): string {
    requireVault()
    return ensureSeatShims(this.seatsRoot)
  }

  markConnecting(userId: string, provider: SeatProvider): Promise<SeatStatus> {
    this.connecting.add(seatKey(userId, provider))
    return this.announce(userId, provider)
  }

  /**
   * A relayed login finished: the file the CLI wrote in the seat directory goes
   * into the vault and leaves the disk. A token was stored by `storeToken` already.
   */
  async markConnected(userId: string, provider: SeatProvider, method: 'login' | 'token'): Promise<SeatStatus> {
    this.connecting.delete(seatKey(userId, provider))
    if (method === 'login') {
      const home = memberSeatDirectory(this.seatsRoot, userId, provider)
      const name = provider === 'claude-code' ? CLAUDE_CREDENTIALS_FILE : CODEX_AUTH_FILE
      const contents = readFileOrNull(join(home, name))
      if (contents === null) {
        log.warn('seat_credential_file_missing', { userId, provider, file: name })
        return this.announce(userId, provider, NO_CREDENTIAL_FILE_MESSAGE)
      }
      const material: CredentialMaterial = { files: { [name]: contents } }
      await putCredential(userId, provider, 'login', material, credentialExpiresAt(provider, material))
      this.removeFiles(home, provider)
    }
    log.info('seat_connected', { userId, provider, method })
    return this.announce(userId, provider)
  }

  markFailed(userId: string, provider: SeatProvider, error: string): Promise<SeatStatus> {
    this.connecting.delete(seatKey(userId, provider))
    log.warn('seat_connect_failed', { userId, provider, error })
    return this.announce(userId, provider, error)
  }

  /** The vault keeps no such state; a refused credential is the person's to reconnect. */
  markExpired(userId: string, provider: SeatProvider, error: string): Promise<SeatStatus> {
    log.warn('seat_expired', { userId, provider, error })
    return this.announce(userId, provider, error)
  }

  /**
   * A credential the person made elsewhere. Claude: a `setup-token`, or the whole
   * `.credentials.json` a login left on another machine, which is a `login`
   * credential here. Codex: the contents of `auth.json`.
   */
  async storeToken(userId: string, provider: SeatProvider, token: string): Promise<SeatStatus> {
    requireVault()
    let material: CredentialMaterial
    let method: 'login' | 'token' = 'token'
    if (provider === 'claude-code') {
      const credentialSet = parseClaudeCredentialSet(token)
      if (credentialSet) {
        material = { files: { [CLAUDE_CREDENTIALS_FILE]: credentialSet } }
        method = 'login'
      } else {
        material = { token: token.trim() }
      }
    } else {
      const auth = parseCodexAuthJson(token)
      if (!auth) throw new Error('Paste the contents of your Codex auth.json file.')
      material = { files: { [CODEX_AUTH_FILE]: `${JSON.stringify(auth)}\n` } }
    }
    await putCredential(userId, provider, method, material, credentialExpiresAt(provider, material))
    this.connecting.delete(seatKey(userId, provider))
    log.info('seat_connected', { userId, provider, method })
    return this.announce(userId, provider)
  }

  async disconnect(userId: string, provider: SeatProvider): Promise<SeatStatus> {
    requireVault()
    await deleteCredential(userId, provider)
    this.removeFiles(memberSeatDirectory(this.seatsRoot, userId, provider), provider)
    log.info('seat_disconnected', { userId, provider })
    return this.announce(userId, provider)
  }

  async remove(userId: string, provider?: SeatProvider): Promise<number> {
    requireVault()
    let removed = 0
    for (const each of provider ? [provider] : SEAT_PROVIDERS) {
      const had = await deleteCredential(userId, each)
      const home = memberSeatDirectory(this.seatsRoot, userId, each)
      if (existsSync(home)) rmSync(home, { recursive: true, force: true })
      if (!had) continue
      removed += 1
      await this.announce(userId, each)
    }
    if (removed) log.info('seat_removed', { userId, removed })
    return removed
  }

  /** A vaulted credential is the person's until they disconnect; nothing idles out. */
  sweep(): Promise<number> {
    return Promise.resolve(0)
  }

  private removeFiles(home: string, provider: SeatProvider): void {
    for (const file of credentialFiles(provider)) rmSync(join(home, file), { force: true })
  }

  private async announce(userId: string, provider: SeatProvider, error?: string): Promise<SeatStatus> {
    const status = await this.status(userId, provider)
    if (error) status.error = error
    const event: SeatChangedEvent = { userId, provider, state: status.state }
    if (error) event.error = error
    for (const listener of this.listeners) {
      try { listener(event) } catch (err) {
        log.warn('seat_change_listener_failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return status
  }
}

function requireVault(): void {
  if (!vaultConfigured()) throw new VaultNotConfiguredError()
}

function seatKey(userId: string, provider: SeatProvider): string {
  return `${userId}\n${provider}`
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
