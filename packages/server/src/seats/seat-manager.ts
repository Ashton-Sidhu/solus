import { integrationUserFor } from '../vault/account-integrations'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { SEAT_PROVIDERS, SEAT_REQUIRED_CODE, seatProviderSchema, type SeatChangedEvent, type SeatProvider, type SeatStatus } from '@solus/contracts/seats'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { principalDisplayName, principalOwnerId, type Principal } from '../server/principal'
import type { TurnActor } from '../sessions/turn-ledger'
import { hostClaudeDir, hostCodexHome, providerLoginConnected } from './seat-login'

const log = createLogger('main', 'seat-manager')

/**
 * Provider seats (docs/plans/provider-seats.md): a seat is a directory the
 * provider CLI reads its login from. The host owner's seat is the host's own
 * provider home, exactly where the setup wizard signs in, so a single-person host
 * runs as it always did. A member's seat is made beside the data directory when
 * they connect. This file owns those directories and the `provider_seat` table;
 * nothing else reads either, and the database handle is injected, so a managed
 * host that moves to Postgres ports this one file.
 *
 * Layout for members, outside the data directory so a backup never copies credentials:
 *
 *     <seatsRoot>/                 0700, the server user
 *       bin/open, bin/xdg-open     a shim that fails: a relayed login never opens a browser on the host
 *       claude/<userId>/           CLAUDE_CONFIG_DIR for that member
 *         projects -> <host ~/.claude>/projects
 *       codex/<userId>/            CODEX_HOME for that member
 *         sessions -> <host ~/.codex>/sessions
 *
 * The transcript directories are links into the host's own provider homes rather
 * than a separate shared tree: the session index reads the host's directories, so
 * this is what lets any member resume any thread on the host (proofs of
 * 2026-08-30 and 2026-09-04). Credentials are per member; transcripts are shared.
 *
 * The owner's seat has no row unless a token was pasted: its state is read from
 * the CLI, so a login made or removed in a terminal is reported truthfully.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_seat (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex')),
  state TEXT NOT NULL CHECK (state IN ('connecting', 'connected', 'expired')),
  method TEXT CHECK (method IN ('login', 'token')),
  error TEXT,
  connected_at INTEGER,
  last_used_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
`

const seatRowSchema = z.object({
  user_id: z.string(),
  provider: seatProviderSchema,
  state: z.enum(['connecting', 'connected', 'expired']),
  method: z.enum(['login', 'token']).nullable(),
  error: z.string().nullable(),
  connected_at: z.number().nullable(),
  last_used_at: z.number(),
  updated_at: z.number(),
})
type SeatRow = z.infer<typeof seatRowSchema>

/** A Better Auth user id, or the host owner sentinel; nothing that could walk the filesystem. */
const seatUserIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/** Seats of members who ran nothing for this long are removed by the sweep (plan §3.7). */
export const SEAT_IDLE_REMOVAL_MS = 30 * 24 * 60 * 60 * 1000

/** A Claude seat connected by pasting a `setup-token`: inference-only, carried in the env per turn. */
export const CLAUDE_TOKEN_FILE = 'solus-seat-token'
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json'
export const CODEX_AUTH_FILE = 'auth.json'

export class SeatRequiredError extends Error {
  readonly code = SEAT_REQUIRED_CODE

  constructor(readonly provider: SeatProvider, readonly state: 'none' | 'connecting' | 'expired') {
    super(state === 'expired'
      ? `Your ${seatProviderLabel(provider)} login on this host expired. Reconnect it to continue.`
      : `Connect your ${seatProviderLabel(provider)} account on this host to run a turn.`)
    this.name = 'SeatRequiredError'
  }
}

export function seatProviderLabel(provider: SeatProvider): string {
  return provider === 'claude-code' ? 'Claude' : 'Codex'
}

/** What a turn gets: the seat's directory and, for a pasted Claude token, the token itself. */
export interface TurnSeat {
  userId: string
  provider: SeatProvider
  home: string
  /** The host's own login: the CLI stays on its defaults and the host process env passes through. */
  isHostLogin?: true
  /** Set for a token seat: injected as `CLAUDE_CODE_OAUTH_TOKEN` for that turn only. */
  envToken?: string
}

/**
 * What the handlers, the connector, and the control plane need of a seat store:
 * implemented by the execution host's SeatManager.
 */
export interface SeatStore {
  onChanged(listener: (event: SeatChangedEvent) => void): () => void
  list(userId: string): Promise<SeatStatus[]>
  status(userId: string, provider: SeatProvider): Promise<SeatStatus>
  resolveForTurn(seatUserId: string, provider: AgentId): Promise<TurnSeat | null>
  connectedSeat(userId: string, provider: SeatProvider): TurnSeat | null
  homeFor(userId: string, provider: SeatProvider): string
  shimBinDir(): string
  markConnecting(userId: string, provider: SeatProvider): Promise<SeatStatus>
  markConnected(userId: string, provider: SeatProvider, method: 'login' | 'token'): Promise<SeatStatus>
  markFailed(userId: string, provider: SeatProvider, error: string): Promise<SeatStatus>
  markExpired(userId: string, provider: SeatProvider, error: string): Promise<SeatStatus>
  storeToken(userId: string, provider: SeatProvider, token: string): Promise<SeatStatus>
  disconnect(userId: string, provider: SeatProvider): Promise<SeatStatus>
  remove(userId: string, provider?: SeatProvider): Promise<number>
  sweep(maxIdleMs?: number): Promise<number>
}

/**
 * Whose seat a principal's prompt runs on (plan §3.3). The host owner sentinel names
 * the host's own login. A guest runs on the seat of whoever shared the link.
 */
export function seatUserFor(principal: Principal): string {
  switch (principal.kind) {
    case 'org-member':
      return principal.userId
    case 'guest':
      return principal.share.sharedByUserId
    case 'local-owner':
    case 'remote-owner':
    case 'runner':
    case 'system':
      return HOST_OWNER_USER_ID
  }
}

/** The ledger's view of a prompt: its author, whose seat it runs on, and how the author is named to others. */
export function turnActorFor(principal: Principal): TurnActor {
  const actor: TurnActor = { userId: principalOwnerId(principal) ?? HOST_OWNER_USER_ID, seatUserId: seatUserFor(principal) }
  actor.credentialUserId = integrationUserFor(principal)
  if (principal.kind !== 'system') actor.displayName = principalDisplayName(principal)
  if (principal.kind === 'org-member' && principal.avatarUrl) actor.avatarUrl = principal.avatarUrl
  return actor
}

export function isSeatProvider(provider: AgentId): provider is SeatProvider {
  return seatProviderSchema.safeParse(provider).success
}

export interface SeatManagerDeps {
  db: DatabaseSync
  /** Defaults to `<SOLUS_DATA_DIR>-seats`, beside the data directory. */
  seatsRoot?: string
  /** The host's own Claude config directory: the owner's seat, and where every member seat's `projects` link points. */
  hostClaudeDir?: string
  /** The host's own Codex home: the owner's seat, and where every member seat's `sessions` link points. */
  hostCodexHome?: string
  /** Whether the host login is signed in; the CLI's own answer by default. */
  hostLoginConnected?: (provider: SeatProvider) => Promise<boolean>
  now?: () => number
}

export class SeatManager implements SeatStore {
  readonly seatsRoot: string
  private readonly hostClaudeDir: string
  private readonly hostCodexHome: string
  private readonly hostLoginConnected: (provider: SeatProvider) => Promise<boolean>
  private readonly listeners = new Set<(event: SeatChangedEvent) => void>()
  constructor(private readonly deps: SeatManagerDeps) {
    deps.db.exec(SCHEMA)
    this.seatsRoot = deps.seatsRoot ?? `${solusDir()}-seats`
    this.hostClaudeDir = deps.hostClaudeDir ?? hostClaudeDir()
    this.hostCodexHome = deps.hostCodexHome ?? hostCodexHome()
    this.hostLoginConnected = deps.hostLoginConnected ?? ((provider) => providerLoginConnected(provider, null))
  }

  onChanged(listener: (event: SeatChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  /** Both providers, with `none` for a seat that has not been connected. */
  list(userId: string): Promise<SeatStatus[]> {
    return Promise.all(SEAT_PROVIDERS.map((provider) => this.status(userId, provider)))
  }

  /** Asynchronous because the host login's answer is the CLI's own status
   *  command — a process, not a row. Everything a seat row answers is still read
   *  from the row. */
  async status(userId: string, provider: SeatProvider): Promise<SeatStatus> {
    const isHostLogin = userId === HOST_OWNER_USER_ID
    const row = this.row(userId, provider)
    if (!row) {
      // The owner's login is the CLI's to report: no row, no stale answer.
      if (isHostLogin) {
        return { provider, state: await this.hostLoginConnected(provider) ? 'connected' : 'none', method: 'login', usageCapable: true, hostLogin: true }
      }
      return { provider, state: 'none', usageCapable: false }
    }
    const status: SeatStatus = {
      provider,
      state: row.state,
      // A pasted Claude token is `user:inference` only; `/usage` cannot read its quota.
      usageCapable: row.state === 'connected' && !(provider === 'claude-code' && row.method === 'token'),
    }
    if (row.method) status.method = row.method
    if (row.connected_at !== null) status.connectedAt = row.connected_at
    if (row.error) status.error = row.error
    if (isHostLogin) status.hostLogin = true
    return status
  }

  /**
   * The seat a turn runs under. The host login always resolves: its owner runs as
   * before, and a missing login is the provider's own error, as it always was. A
   * member with no usable seat for the session's provider is refused with
   * `SeatRequiredError` before anything is spawned (plan §3.3).
   */
  async resolveForTurn(seatUserId: string, provider: AgentId): Promise<TurnSeat | null> {
    if (!isSeatProvider(provider)) return null
    if (seatUserId === HOST_OWNER_USER_ID) return this.connectedSeat(seatUserId, provider)
    const row = this.row(seatUserId, provider)
    if (!row) throw new SeatRequiredError(provider, 'none')
    if (row.state !== 'connected') throw new SeatRequiredError(provider, row.state)
    const seat = this.connectedSeat(seatUserId, provider)
    if (!seat) throw new SeatRequiredError(provider, 'none')
    this.deps.db.prepare('UPDATE provider_seat SET last_used_at = ? WHERE user_id = ? AND provider = ?').run(this.now(), seatUserId, provider)
    return seat
  }

  /**
   * A connected seat for a provider, or null. A read: the usage meter probes through
   * this without touching last use. The owner's is never null: with no pasted token
   * it is the host login itself.
   */
  connectedSeat(userId: string, provider: SeatProvider): TurnSeat | null {
    const isHostLogin = userId === HOST_OWNER_USER_ID
    const row = this.row(userId, provider)
    if (!row && !isHostLogin) return null
    if (row && row.state !== 'connected') return isHostLogin ? this.hostLoginSeat(provider) : null
    const seat: TurnSeat = isHostLogin
      ? this.hostLoginSeat(provider)
      : { userId, provider, home: this.memberHome(userId, provider) }
    const home = seat.home
    if (provider === 'claude-code' && row?.method === 'token') {
      const token = readFileOrNull(join(home, CLAUDE_TOKEN_FILE))?.trim()
      if (!token) return isHostLogin ? this.hostLoginSeat(provider) : null
      seat.envToken = token
    }
    return seat
  }

  /** The member's directory for a provider, created with its links on first use; the owner's is the host's own home. */
  homeFor(userId: string, provider: SeatProvider): string {
    if (userId === HOST_OWNER_USER_ID) return this.hostHomeFor(provider)
    return this.memberHome(userId, provider)
  }

  /** A directory whose `open` and `xdg-open` fail, so a relayed login prints its URL instead of opening the host's browser. */
  shimBinDir(): string {
    this.ensureShims()
    return join(this.seatsRoot, 'bin')
  }

  // ── Writing ─────────────────────────────────────────────────────────────

  markConnecting(userId: string, provider: SeatProvider): Promise<SeatStatus> {
    this.upsert(userId, provider, { state: 'connecting', method: 'login', error: null })
    return this.announce(userId, provider)
  }

  /** The provider CLI finished its login and the credential verified in the seat's directory. */
  markConnected(userId: string, provider: SeatProvider, method: 'login' | 'token'): Promise<SeatStatus> {
    if (userId === HOST_OWNER_USER_ID && method === 'login') {
      // The host login answers for itself from here on; a row would only go stale.
      this.deleteRow(userId, provider)
    } else {
      this.upsert(userId, provider, { state: 'connected', method, error: null, connectedAt: this.now() })
    }
    log.info('seat_connected', { userId, provider, method })
    return this.announce(userId, provider)
  }

  /** A connect attempt ended without a credential: back to where it was, with the reason on the event. */
  markFailed(userId: string, provider: SeatProvider, error: string): Promise<SeatStatus> {
    const row = this.row(userId, provider)
    if (row?.state === 'connected') return this.status(userId, provider)
    this.deleteRow(userId, provider)
    log.warn('seat_connect_failed', { userId, provider, error })
    return this.announce(userId, provider, error)
  }

  /** The provider refused the credential during a turn (plan §3.7): the next prompt asks to reconnect. */
  markExpired(userId: string, provider: SeatProvider, error: string): Promise<SeatStatus> {
    const row = this.row(userId, provider)
    if (!row || row.state !== 'connected') return this.status(userId, provider)
    this.upsert(userId, provider, { state: 'expired', method: row.method ?? undefined, error })
    log.warn('seat_expired', { userId, provider, error })
    return this.announce(userId, provider)
  }

  /** A credential the member made elsewhere (plan §3.2 `seatConnectToken`). */
  async storeToken(userId: string, provider: SeatProvider, token: string): Promise<SeatStatus> {
    const home = this.homeFor(userId, provider)
    // The host's own provider home may not exist yet on a host that never ran the CLI.
    mkdirSync(home, { recursive: true })
    if (provider === 'claude-code') {
      writeFileSync(join(home, CLAUDE_TOKEN_FILE), `${token.trim()}\n`, { mode: 0o600 })
    } else {
      const auth = parseCodexAuthJson(token)
      if (!auth) throw new Error('Paste the contents of your Codex auth.json file.')
      writeFileSync(join(home, CODEX_AUTH_FILE), `${JSON.stringify(auth)}\n`, { mode: 0o600 })
    }
    return this.markConnected(userId, provider, 'token')
  }

  /**
   * Deletes the credential and keeps the directory; the member can connect again.
   * For the host login only a pasted token is Solus's to delete: the CLI's own
   * sign-in stays, and a different account is a new sign-in over it.
   */
  disconnect(userId: string, provider: SeatProvider): Promise<SeatStatus> {
    const home = this.homeFor(userId, provider)
    const files = userId === HOST_OWNER_USER_ID ? [CLAUDE_TOKEN_FILE] : credentialFiles(provider)
    for (const file of files) rmSync(join(home, file), { force: true })
    this.deleteRow(userId, provider)
    log.info('seat_disconnected', { userId, provider })
    return this.announce(userId, provider)
  }

  /** Deletes a member's seat directories and rows: on removal from the team (plan §3.7). Never the host's own home. */
  async remove(userId: string, provider?: SeatProvider): Promise<number> {
    if (userId === HOST_OWNER_USER_ID) throw new Error('The host login is not a seat that can be removed.')
    const providers = provider ? [provider] : SEAT_PROVIDERS
    let removed = 0
    for (const each of providers) {
      const safeUserId = seatUserIdSchema.parse(userId)
      const home = join(this.seatsRoot, each === 'claude-code' ? 'claude' : 'codex', safeUserId)
      const hadRow = !!this.row(userId, each)
      if (existsSync(home)) rmSync(home, { recursive: true, force: true })
      this.deleteRow(userId, each)
      if (hadRow) {
        removed += 1
        await this.announce(userId, each)
      }
    }
    if (removed) log.info('seat_removed', { userId, removed })
    return removed
  }

  /** Removes every member seat unused for `maxIdleMs` (default thirty days). Returns how many. */
  async sweep(maxIdleMs = SEAT_IDLE_REMOVAL_MS): Promise<number> {
    const cutoff = this.now() - maxIdleMs
    const idle = seatRowSchema.array().parse(
      this.deps.db.prepare('SELECT * FROM provider_seat WHERE last_used_at < ? AND user_id != ?').all(cutoff, HOST_OWNER_USER_ID),
    )
    let removed = 0
    for (const row of idle) removed += await this.remove(row.user_id, row.provider)
    if (removed) log.info('seat_sweep', { removed })
    return removed
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private hostHomeFor(provider: SeatProvider): string {
    return provider === 'claude-code' ? this.hostClaudeDir : this.hostCodexHome
  }

  private hostLoginSeat(provider: SeatProvider): TurnSeat {
    return { userId: HOST_OWNER_USER_ID, provider, home: this.hostHomeFor(provider), isHostLogin: true }
  }

  /** A member's directory, created with its links on first use. */
  private memberHome(userId: string, provider: SeatProvider): string {
    const home = memberSeatDirectory(this.seatsRoot, userId, provider)
    if (provider === 'claude-code') {
      ensureLink(join(home, 'projects'), join(this.hostClaudeDir, 'projects'))
    } else {
      ensureLink(join(home, 'sessions'), join(this.hostCodexHome, 'sessions'))
    }
    return home
  }

  private row(userId: string, provider: SeatProvider): SeatRow | null {
    return seatRowSchema.nullish().parse(
      this.deps.db.prepare('SELECT * FROM provider_seat WHERE user_id = ? AND provider = ?').get(userId, provider),
    ) ?? null
  }

  private deleteRow(userId: string, provider: SeatProvider): void {
    this.deps.db.prepare('DELETE FROM provider_seat WHERE user_id = ? AND provider = ?').run(userId, provider)
  }

  private upsert(userId: string, provider: SeatProvider, next: { state: SeatRow['state']; method?: 'login' | 'token'; error: string | null; connectedAt?: number }): void {
    seatUserIdSchema.parse(userId)
    const now = this.now()
    this.deps.db.prepare(`
      INSERT INTO provider_seat (user_id, provider, state, method, error, connected_at, last_used_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        state = excluded.state,
        method = excluded.method,
        error = excluded.error,
        connected_at = COALESCE(excluded.connected_at, provider_seat.connected_at),
        last_used_at = excluded.last_used_at,
        updated_at = excluded.updated_at
    `).run(userId, provider, next.state, next.method ?? null, next.error, next.connectedAt ?? null, now, now)
  }

  private async announce(userId: string, provider: SeatProvider, error?: string): Promise<SeatStatus> {
    const status = await this.status(userId, provider)
    const event: SeatChangedEvent = { userId, provider, state: status.state }
    if (error ?? status.error) event.error = error ?? status.error
    for (const listener of this.listeners) {
      try { listener(event) } catch (err) {
        log.warn('seat_change_listener_failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return status
  }

  private ensureShims(): void {
    ensureSeatShims(this.seatsRoot)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** The files a provider keeps its login in, inside a seat directory. */
export function credentialFiles(provider: SeatProvider): string[] {
  return provider === 'claude-code' ? [CLAUDE_CREDENTIALS_FILE, CLAUDE_TOKEN_FILE] : [CODEX_AUTH_FILE]
}

/** A member's seat directory under the seats root, made 0700 on first use, without its transcript links. */
export function memberSeatDirectory(seatsRoot: string, userId: string, provider: SeatProvider): string {
  const safeUserId = seatUserIdSchema.parse(userId)
  ensureDir(seatsRoot, 0o700)
  ensureSeatShims(seatsRoot)
  const level = join(seatsRoot, provider === 'claude-code' ? 'claude' : 'codex')
  ensureDir(level, 0o700)
  const home = join(level, safeUserId)
  ensureDir(home, 0o700)
  return home
}

/** The `bin` beside the seats whose `open` and `xdg-open` fail: a relayed login prints its URL instead. */
export function ensureSeatShims(seatsRoot: string): string {
  const bin = join(seatsRoot, 'bin')
  ensureDir(bin, 0o700)
  for (const name of ['open', 'xdg-open']) {
    const path = join(bin, name)
    if (existsSync(path)) continue
    writeFileSync(path, '#!/bin/sh\n# Solus seat shim: a relayed login must not open a browser on the host.\nexit 1\n', { mode: 0o700 })
  }
  return bin
}

function ensureDir(path: string, mode: number): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode })
  chmodSync(path, mode)
}

/** Points `linkPath` at `target`, replacing a link that points elsewhere; a real directory there is left alone. */
function ensureLink(linkPath: string, target: string): void {
  mkdirSync(target, { recursive: true })
  let current: ReturnType<typeof lstatSync> | null = null
  try { current = lstatSync(linkPath) } catch { current = null }
  if (current) {
    if (!current.isSymbolicLink()) return
    if (readlinkSync(linkPath) === target) return
    unlinkSync(linkPath)
  }
  symlinkSync(target, linkPath, 'dir')
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Codex's own file, kept whole: its shape is the CLI's, and only its being an object is Solus's business. */
const codexAuthJsonSchema = z.looseObject({})
type CodexAuthJson = z.infer<typeof codexAuthJsonSchema>

export function parseCodexAuthJson(text: string): CodexAuthJson | null {
  try {
    const parsed = codexAuthJsonSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
