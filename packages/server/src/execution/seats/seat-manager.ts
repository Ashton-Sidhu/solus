import { privateProviderInstances } from './provider-instances'
import { captureActingScope } from '../../vault/acting-scope'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import { HOST_LOGIN_SEAT, SEAT_PROVIDERS, SEAT_REQUIRED_CODE, seatProviderSchema, type Seat, type SeatChangedEvent, type SeatProvider, type SeatStatus } from '@solus/contracts/seats'
import { parseUserKey, userKey, type UserId } from '@solus/contracts/user'
import { createLogger } from '../../logger'
import { solusDir } from '../../platform/paths'
import { memberFolderFor, recordedMemberFolder } from '../../host/member-folders'
import { hostClaudeDir, hostCodexHome, providerLoginConnected } from './seat-login'
import { AGENT_LABELS } from '@solus/contracts/types'
import { ANTIGRAVITY_ADC_FILE, ANTIGRAVITY_SIGN_IN_FILE, ANTIGRAVITY_TOKEN_FILE, antigravitySignInRecord, hostAntigravityProfile, type AntigravityAuth } from '../agents/acp/antigravity-auth'
import { ANTIGRAVITY_BROWSER_MARKER } from './antigravity-enterprise-sign-in'
import type { AntigravityCredential } from '@solus/contracts/seats'
import { identityFor } from './acting-identity'
import { applyMemberFiles, type MemberFileChange } from './member-files'
import { memberUsers } from '../../host/member-users'
import type { LaunchOptions, ProcessUser } from '../../cli-env'

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
 *       claude/<folder>/           CLAUDE_CONFIG_DIR for that member
 *         projects -> <host ~/.claude>/projects
 *       codex/<folder>/            CODEX_HOME for that member
 *         sessions -> <host ~/.codex>/sessions
 *       home/<folder>/             HOME for that member's processes (plans/019-acting-identity.md)
 *
 * `<folder>` is the member's folder name on this host (`host/member-folders.ts`):
 * their name, the same folder their projects live in.
 *
 * The transcript directories are links into the host's own provider homes rather
 * than a separate shared tree: the session index reads the host's directories, so
 * this is what lets any member resume any thread on the host (proofs of
 * 2026-08-30 and 2026-09-04). Credentials are per member; transcripts are shared.
 *
 * Where each member is their own Linux user (docs/plans/member-isolation.md §5),
 * a member's seat folders hold only their logins: the CLIs keep their defaults
 * under the member's `HOME`, whose login files link here and whose transcript
 * folders link to the host's one transcript folder (§5.1).
 *
 * The owner's seat has no row unless a token was pasted: its state is read from
 * the CLI, so a login made or removed in a terminal is reported truthfully.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_seat (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude-code', 'codex', 'antigravity')),
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

/**
 * The `user_id` the host login's row is stored under. `@` is outside the user seat
 * id pattern below, so no user's seat can share it.
 */
const HOST_LOGIN_ROW_ID = '@host-login'
/** What the host login's row was stored under before plan 012 stage 2; moved once at startup. */
const LEGACY_HOST_LOGIN_ROW_ID = 'host-owner'

/** A string for maps, logs, and the `provider_seat.user_id` column: a user seat is its user's key. */
export function seatKey(seat: Seat): string {
  return seat.kind === 'host-login' ? HOST_LOGIN_ROW_ID : userKey(seat.userId)
}

function rowKey(seat: Seat, provider: SeatProvider): string {
  return `${seatKey(seat)}\u0000${provider}`
}

/** A user seat's key is a Better Auth user id; nothing that could walk the filesystem. */
const seatUserIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/** Seats of members who ran nothing for this long are removed by the sweep (plan §3.7). */
export const SEAT_IDLE_REMOVAL_MS = 30 * 24 * 60 * 60 * 1000

const API_KEY_RE = /^[A-Za-z0-9_.-]{10,512}$/
/** Application Default Credentials: a JSON object that names its kind, as gcloud writes it. */
const adcSchema = z.looseObject({ type: z.enum(['authorized_user', 'service_account', 'external_account', 'impersonated_service_account']) })

/**
 * The files a pasted Antigravity credential becomes (§7): a Gemini API key, or
 * for Vertex AI an API key or Application Default Credentials, kept in the seat's
 * profile; the record says which.
 */
interface AntigravityCredentialFiles {
  files: MemberFileChange[]
  auth: AntigravityAuth
}

function antigravityCredentialFiles(home: string, token: string, credential: AntigravityCredential): AntigravityCredentialFiles {
  const text = token.trim()
  if (credential.method === 'gemini-api-key') {
    if (!API_KEY_RE.test(text)) throw new Error('Paste a Gemini API key.')
    return { files: [], auth: { method: 'gemini-api-key', apiKey: text } }
  }
  const { gcpProject, gcpLocation } = credential
  let adc: z.infer<typeof adcSchema> | null = null
  try { adc = adcSchema.parse(JSON.parse(text)) } catch { adc = null }
  if (adc) {
    return {
      files: [{ kind: 'write', path: join(home, ANTIGRAVITY_ADC_FILE), content: `${JSON.stringify(adc)}\n`, mode: 0o600 }],
      auth: { method: 'agent-platform', gcpProject, gcpLocation },
    }
  }
  if (!API_KEY_RE.test(text)) throw new Error('Paste a Google Cloud API key, or the contents of your application_default_credentials.json file.')
  // A key replaces credentials pasted before it.
  return { files: [{ kind: 'remove', path: join(home, ANTIGRAVITY_ADC_FILE) }], auth: { method: 'agent-platform', apiKey: text, gcpProject, gcpLocation } }
}

/** A Claude seat connected by pasting a `setup-token`: inference-only, carried in the env per turn. */
export const CLAUDE_TOKEN_FILE = 'solus-seat-token'
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json'
export const CODEX_AUTH_FILE = 'auth.json'

/** The folder under the seats root that holds each provider's member seats. */
const SEAT_FOLDERS = {
  'claude-code': 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
} as const satisfies Record<SeatProvider, string>

/** The file a provider CLI writes when a sign-in succeeds, inside a seat directory. */
const LOGIN_FILES = {
  'claude-code': CLAUDE_CREDENTIALS_FILE,
  codex: CODEX_AUTH_FILE,
  antigravity: ANTIGRAVITY_TOKEN_FILE,
} as const satisfies Record<SeatProvider, string>

/** Every file a seat's login is kept in: a CLI's own sign-in, and what a person pasted. */
const CREDENTIAL_FILES = {
  'claude-code': [CLAUDE_CREDENTIALS_FILE, CLAUDE_TOKEN_FILE],
  codex: [CODEX_AUTH_FILE],
  antigravity: [ANTIGRAVITY_TOKEN_FILE, ANTIGRAVITY_SIGN_IN_FILE, ANTIGRAVITY_ADC_FILE],
} as const satisfies Record<SeatProvider, readonly string[]>

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
  return AGENT_LABELS[provider]
}


/** What a turn gets: the seat's directory and, for a pasted Claude token, the token itself. */
export interface TurnSeat {
  /** Whose seat. The host login keeps the CLI on its defaults, and the host process env passes through. */
  seat: Seat
  provider: SeatProvider
  home: string
  /** Set for a token seat: injected as `CLAUDE_CODE_OAUTH_TOKEN` for that turn only. */
  envToken?: string
  /**
   * A member's launch options from their acting identity: their environment and,
   * on a shared host, their OS user (docs/plans/member-isolation.md §3). Absent for
   * the host login, which keeps the host's.
   */
  launch?: LaunchOptions
}

/**
 * The caller's own provider login for a backend: null for the host login.
 * Throws `SeatRequiredError` when the caller has no login for that backend.
 */
export type SeatResolver = (provider: AgentId) => Promise<TurnSeat | null>

/**
 * What the handlers, the connector, and the control plane need of a seat store:
 * implemented by the execution host's SeatManager.
 */
export interface SeatStore {
  onChanged(listener: (event: SeatChangedEvent) => void): () => void
  list(seat: Seat): Promise<SeatStatus[]>
  status(seat: Seat, provider: SeatProvider): Promise<SeatStatus>
  resolveForTurn(seat: Seat, provider: AgentId): Promise<TurnSeat | null>
  connectedSeat(seat: Seat, provider: SeatProvider): TurnSeat | null
  homeFor(seat: Seat, provider: SeatProvider): string
  shimBinDir(): string
  markConnecting(seat: Seat, provider: SeatProvider): Promise<SeatStatus>
  markConnected(seat: Seat, provider: SeatProvider, method: 'login' | 'token', antigravity?: AntigravityAuth): Promise<SeatStatus>
  markFailed(seat: Seat, provider: SeatProvider, error: string): Promise<SeatStatus>
  markExpired(seat: Seat, provider: SeatProvider, error: string): Promise<SeatStatus>
  storeToken(seat: Seat, provider: SeatProvider, token: string, antigravity?: AntigravityCredential): Promise<SeatStatus>
  disconnect(seat: Seat, provider: SeatProvider): Promise<SeatStatus>
  remove(userId: UserId, provider?: SeatProvider): Promise<number>
  sweep(maxIdleMs?: number): Promise<number>
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
  /** The host login's Antigravity profile (docs/plans/antigravity-provider.md §7). */
  hostAntigravityProfile?: string
  /** Whether the host login is signed in; the CLI's own answer by default. */
  hostLoginConnected?: (provider: SeatProvider) => Promise<boolean>
  /** Whether a member's seat directory holds a working login; the CLI's own answer by default. */
  memberLoginConnected?: (provider: SeatProvider, home: string) => Promise<boolean>
  now?: () => number
}

export class SeatManager implements SeatStore {
  readonly seatsRoot: string
  private readonly hostClaudeDir: string
  private readonly hostCodexHome: string
  private readonly hostAntigravityProfile: string
  private readonly hostLoginConnected: (provider: SeatProvider) => Promise<boolean>
  private readonly memberLoginConnected: (provider: SeatProvider, home: string) => Promise<boolean>
  private readonly listeners = new Set<(event: SeatChangedEvent) => void>()
  /** `seatKey:provider` → its row, or null for none. Every turn resolves a seat
   *  at least twice, and this manager is the table's only writer, so a row is
   *  read once until this manager changes it. */
  private readonly rows = new Map<string, SeatRow | null>()
  constructor(private readonly deps: SeatManagerDeps) {
    deps.db.exec(SCHEMA)
    allowEverySeatProvider(deps.db)
    // A pasted owner token was stored under the old owner sentinel; it is the host login's.
    deps.db.prepare('UPDATE OR IGNORE provider_seat SET user_id = ? WHERE user_id = ?').run(HOST_LOGIN_ROW_ID, LEGACY_HOST_LOGIN_ROW_ID)
    deps.db.prepare('DELETE FROM provider_seat WHERE user_id = ?').run(LEGACY_HOST_LOGIN_ROW_ID)
    this.seatsRoot = deps.seatsRoot ?? `${solusDir()}-seats`
    this.hostClaudeDir = deps.hostClaudeDir ?? hostClaudeDir()
    this.hostCodexHome = deps.hostCodexHome ?? hostCodexHome()
    this.hostAntigravityProfile = deps.hostAntigravityProfile ?? hostAntigravityProfile()
    this.hostLoginConnected = deps.hostLoginConnected ?? ((provider) => providerLoginConnected(provider, null))
    this.memberLoginConnected = deps.memberLoginConnected ?? providerLoginConnected
  }

  onChanged(listener: (event: SeatChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  /** Both providers, with `none` for a seat that has not been connected. */
  list(seat: Seat): Promise<SeatStatus[]> {
    return Promise.all(SEAT_PROVIDERS.map((provider) => this.status(seat, provider)))
  }

  /** Asynchronous because the host login's answer is the CLI's own status
   *  command — a process, not a row. Everything a seat row answers is still read
   *  from the row. */
  async status(seat: Seat, provider: SeatProvider): Promise<SeatStatus> {
    if (seat.kind === 'user') await this.adoptPresentLogin(seat, provider)
    const isHostLogin = seat.kind === 'host-login'
    const row = this.row(seat, provider)
    if (!row) {
      // The host login is the CLI's to report: no row, no stale answer.
      if (isHostLogin) {
        return { provider, state: await this.hostLoginConnected(provider) ? 'connected' : 'none', method: 'login', usageCapable: provider !== 'antigravity', hostLogin: true }
      }
      return { provider, state: 'none', usageCapable: false }
    }
    const status: SeatStatus = {
      provider,
      state: row.state,
      // A pasted Claude token is `user:inference` only; `/usage` cannot read its quota.
      // Google publishes no quota endpoint for Antigravity (docs/plans/antigravity-provider.md §9).
      usageCapable: row.state === 'connected' && provider !== 'antigravity' && !(provider === 'claude-code' && row.method === 'token'),
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
   * user with no usable seat for the session's provider is refused with
   * `SeatRequiredError` before anything is spawned (plan §3.3).
   */
  async resolveForTurn(seat: Seat, provider: AgentId): Promise<TurnSeat | null> {
    if (!isSeatProvider(provider)) return null
    if (seat.kind === 'host-login') return this.connectedSeat(seat, provider)
    const personKey = captureActingScope()?.personKey
    if (personKey) {
      const snapshot = privateProviderInstances().snapshot(personKey)
      const hasPrivateRuntime = snapshot.instances.some((instance) => instance.provider === provider && (instance.id !== provider || instance.homePath || instance.shadowHomePath || instance.environment.length))
      if (hasPrivateRuntime) {
        return { seat, provider, home: this.homeFor(seat, provider), launch: await identityFor(seat).launchOptions() }
      }
    }
    await this.adoptPresentLogin(seat, provider)
    const row = this.row(seat, provider)
    if (!row) throw new SeatRequiredError(provider, 'none')
    if (row.state !== 'connected') throw new SeatRequiredError(provider, row.state)
    const turnSeat = this.connectedSeat(seat, provider)
    if (!turnSeat) throw new SeatRequiredError(provider, 'none')
    const usedAt = this.now()
    this.deps.db.prepare('UPDATE provider_seat SET last_used_at = ? WHERE user_id = ? AND provider = ?').run(usedAt, seatKey(seat), provider)
    this.rows.set(rowKey(seat, provider), { ...row, last_used_at: usedAt })
    // A turn waits for the member's GitHub connection, so their commits name them.
    turnSeat.launch = await identityFor(seat).launchOptions()
    return turnSeat
  }

  /**
   * A connected seat for a provider, or null. A read: the usage meter probes through
   * this without touching last use. The host login's is never null: with no pasted
   * token it is the host's own provider home.
   */
  connectedSeat(seat: Seat, provider: SeatProvider): TurnSeat | null {
    const isHostLogin = seat.kind === 'host-login'
    const row = this.row(seat, provider)
    if (!row && !isHostLogin) return null
    if (row && row.state !== 'connected') return isHostLogin ? this.hostLoginSeat(provider) : null
    const turnSeat: TurnSeat = isHostLogin
      ? this.hostLoginSeat(provider)
      : { seat, provider, home: this.userHome(seat, provider), launch: identityFor(seat).launchOptionsSync() }
    if (provider === 'claude-code' && row?.method === 'token') {
      const token = readFileOrNull(join(turnSeat.home, CLAUDE_TOKEN_FILE))?.trim()
      if (!token) return isHostLogin ? this.hostLoginSeat(provider) : null
      turnSeat.envToken = token
    }
    return turnSeat
  }

  /**
   * WORKAROUND(openai/codex#54472): the seat a thread's history is read through,
   * by the key of the seat that last ran it (`data/sessions/codex-thread-writers.ts`).
   * A read needs no login, so an expired seat still answers. A member whose seat
   * row is gone answers null, and the caller reads on the host's app-server.
   * The launch options are the ones a turn gets, because a run reuses an
   * app-server a read started.
   */
  async readerSeat(key: string, provider: SeatProvider): Promise<TurnSeat | null> {
    if (key === HOST_LOGIN_ROW_ID) return this.hostLoginSeat(provider)
    const seat: Extract<Seat, { kind: 'user' }> = { kind: 'user', userId: parseUserKey(key) }
    if (!this.row(seat, provider)) return null
    return { seat, provider, home: this.userHome(seat, provider), launch: await identityFor(seat).launchOptions() }
  }

  /** A user's directory for a provider, created with its links on first use; the host login's is the host's own home. */
  homeFor(seat: Seat, provider: SeatProvider): string {
    return seat.kind === 'host-login' ? this.hostHomeFor(provider) : this.userHome(seat, provider)
  }

  /** A directory whose `open` and `xdg-open` fail, so a relayed login prints its URL instead of opening the host's browser. */
  shimBinDir(): string {
    this.ensureShims()
    return join(this.seatsRoot, 'bin')
  }

  // ── Writing ─────────────────────────────────────────────────────────────

  markConnecting(seat: Seat, provider: SeatProvider): Promise<SeatStatus> {
    this.upsert(seat, provider, { state: 'connecting', method: 'login', error: null })
    return this.announce(seat, provider)
  }

  /** The provider CLI finished its login and the credential verified in the seat's directory. */
  markConnected(seat: Seat, provider: SeatProvider, method: 'login' | 'token', antigravity?: AntigravityAuth): Promise<SeatStatus> {
    // The newest Antigravity sign-in is the one the profile signs in with (§7).
    if (provider === 'antigravity' && antigravity) {
      applyMemberFiles(processUserOf(seat), [{ kind: 'write', path: join(this.homeFor(seat, provider), ANTIGRAVITY_SIGN_IN_FILE), content: antigravitySignInRecord(antigravity), mode: 0o600 }])
    }
    if (seat.kind === 'host-login' && method === 'login') {
      // The host login answers for itself from here on; a row would only go stale.
      this.deleteRow(seat, provider)
    } else {
      this.upsert(seat, provider, { state: 'connected', method, error: null, connectedAt: this.now() })
    }
    log.info('seat_connected', { seat: seatKey(seat), provider, method })
    return this.announce(seat, provider)
  }

  /** A connect attempt ended without a credential: back to where it was, with the reason on the event. */
  markFailed(seat: Seat, provider: SeatProvider, error: string): Promise<SeatStatus> {
    const row = this.row(seat, provider)
    if (row?.state === 'connected') return this.status(seat, provider)
    this.deleteRow(seat, provider)
    log.warn('seat_connect_failed', { seat: seatKey(seat), provider, error })
    return this.announce(seat, provider, error)
  }

  /** The provider refused the credential during a turn (plan §3.7): the next prompt asks to reconnect. */
  markExpired(seat: Seat, provider: SeatProvider, error: string): Promise<SeatStatus> {
    const row = this.row(seat, provider)
    if (!row || row.state !== 'connected') return this.status(seat, provider)
    this.upsert(seat, provider, { state: 'expired', method: row.method ?? undefined, error })
    log.warn('seat_expired', { seat: seatKey(seat), provider, error })
    return this.announce(seat, provider)
  }

  /** A credential the user made elsewhere (plan §3.2 `seatConnectToken`). */
  async storeToken(seat: Seat, provider: SeatProvider, token: string, antigravity?: AntigravityCredential): Promise<SeatStatus> {
    const home = this.homeFor(seat, provider)
    // The host's own provider home may not exist yet on a host that never ran the CLI; the write makes it.
    if (provider === 'antigravity') {
      const { files, auth } = antigravityCredentialFiles(home, token, antigravity ?? { method: 'gemini-api-key' })
      applyMemberFiles(processUserOf(seat), files)
      return this.markConnected(seat, provider, 'token', auth)
    }
    let file: MemberFileChange
    if (provider === 'claude-code') {
      file = { kind: 'write', path: join(home, CLAUDE_TOKEN_FILE), content: `${token.trim()}\n`, mode: 0o600 }
    } else {
      const auth = parseCodexAuthJson(token)
      if (!auth) throw new Error('Paste the contents of your Codex auth.json file.')
      file = { kind: 'write', path: join(home, CODEX_AUTH_FILE), content: `${JSON.stringify(auth)}\n`, mode: 0o600 }
    }
    applyMemberFiles(processUserOf(seat), [file])
    return this.markConnected(seat, provider, 'token')
  }

  /**
   * Deletes the credential and keeps the directory; the user can connect again.
   * For the host login only a pasted token is Solus's to delete: the CLI's own
   * sign-in stays, and a different account is a new sign-in over it.
   */
  disconnect(seat: Seat, provider: SeatProvider): Promise<SeatStatus> {
    const home = this.homeFor(seat, provider)
    // The host login's Antigravity profile is Solus's own (§7), so its whole login is Solus's to delete.
    const files = seat.kind === 'host-login' && provider !== 'antigravity' ? [CLAUDE_TOKEN_FILE] : credentialFiles(provider)
    applyMemberFiles(processUserOf(seat), files.map((file) => ({ kind: 'remove', path: join(home, file) })))
    this.deleteRow(seat, provider)
    log.info('seat_disconnected', { seat: seatKey(seat), provider })
    return this.announce(seat, provider)
  }

  /**
   * Deletes a user's seat directories and rows: on removal from the team (plan §3.7).
   * The host login is not a user seat, so it is never removed. Where each member is
   * their own user, their folders are the host object's: only the login goes, and
   * nothing when the host object already removed the user and their folders.
   */
  async remove(userId: UserId, provider?: SeatProvider): Promise<number> {
    const seat: Extract<Seat, { kind: 'user' }> = { kind: 'user', userId }
    const safeUserId = seatUserIdSchema.parse(seatKey(seat))
    const isolated = memberUsers() !== null
    const user = isolated ? memberUsers()?.userOf(safeUserId) ?? null : null
    const providers = provider ? [provider] : SEAT_PROVIDERS
    let removed = 0
    for (const each of providers) {
      const hadRow = !!this.row(seat, each)
      if (!isolated) {
        const home = join(this.seatsRoot, SEAT_FOLDERS[each], this.folderOf(seat))
        if (existsSync(home)) rmSync(home, { recursive: true, force: true })
      } else if (user) {
        const home = join(this.seatsRoot, SEAT_FOLDERS[each], user.username)
        applyMemberFiles({ uid: user.uid }, credentialFiles(each).map((file) => ({ kind: 'remove', path: join(home, file) })))
      }
      this.deleteRow(seat, each)
      if (hadRow) {
        removed += 1
        await this.announce(seat, each)
      }
    }
    if (removed) log.info('seat_removed', { seat: safeUserId, removed })
    return removed
  }

  /** The user key of every user with a seat row; the host login is not a user. */
  memberUserIds(): string[] {
    const rows = z.object({ user_id: z.string() }).array().parse(
      this.deps.db.prepare('SELECT DISTINCT user_id FROM provider_seat WHERE user_id != ?').all(HOST_LOGIN_ROW_ID),
    )
    return rows.map((row) => row.user_id)
  }

  /** Removes every user seat unused for `maxIdleMs` (default thirty days). Returns how many. */
  async sweep(maxIdleMs = SEAT_IDLE_REMOVAL_MS): Promise<number> {
    const cutoff = this.now() - maxIdleMs
    const idle = seatRowSchema.array().parse(
      this.deps.db.prepare('SELECT * FROM provider_seat WHERE last_used_at < ? AND user_id != ?').all(cutoff, HOST_LOGIN_ROW_ID),
    )
    let removed = 0
    for (const row of idle) removed += await this.remove(parseUserKey(row.user_id), row.provider)
    if (removed) log.info('seat_sweep', { removed })
    return removed
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private hostHomeFor(provider: SeatProvider): string {
    return { 'claude-code': this.hostClaudeDir, codex: this.hostCodexHome, antigravity: this.hostAntigravityProfile }[provider]
  }

  private hostLoginSeat(provider: SeatProvider): TurnSeat {
    return { seat: HOST_LOGIN_SEAT, provider, home: this.hostHomeFor(provider) }
  }

  /**
   * A user's directory, created with its links on first use. Where each member is
   * their own user, the host object made it and its links (docs/plans/member-isolation.md §5).
   */
  private userHome(seat: Extract<Seat, { kind: 'user' }>, provider: SeatProvider): string {
    if (memberUsers()) return join(this.seatsRoot, SEAT_FOLDERS[provider], this.folderOf(seat))
    const home = memberSeatDirectory(this.seatsRoot, this.folderOf(seat), provider)
    // Antigravity's history is the kept history Solus writes, so its profile needs no link.
    if (provider === 'claude-code') {
      ensureLink(join(home, 'projects'), join(this.hostClaudeDir, 'projects'))
    } else if (provider === 'codex') {
      ensureLink(join(home, 'sessions'), join(this.hostCodexHome, 'sessions'))
    }
    return home
  }

  /** The folder a user's seats live in: their member folder, named once their name is known. */
  private folderOf(seat: Extract<Seat, { kind: 'user' }>): string {
    return memberFolderFor(seatUserIdSchema.parse(seatKey(seat)), seat.name)
  }

  /**
   * A member's login that is in their seat directory without a sign-in on this host
   * (copied in by whatever provisions the machine) connects their seat. Only a file
   * the provider CLI writes counts, and the CLI's own check must pass. An expired
   * seat is connected again only by a credential written after it expired, so a
   * refused login does not come back by itself. A sign-in in progress is left alone.
   */
  private async adoptPresentLogin(seat: Extract<Seat, { kind: 'user' }>, provider: SeatProvider): Promise<void> {
    const row = this.row(seat, provider)
    if (row?.state === 'connected' || row?.state === 'connecting') return
    // A read: look in the folders that exist, and make none. The named folder, or the
    // user id's when the login arrived before the name did.
    const userId = seatUserIdSchema.parse(seatKey(seat))
    const level = join(this.seatsRoot, SEAT_FOLDERS[provider])
    const file = LOGIN_FILES[provider]
    let found: { home: string; writtenAt: number } | null = null
    for (const folder of new Set([recordedMemberFolder(userId), userId])) {
      try {
        found = { home: join(level, folder), writtenAt: statSync(join(level, folder, file)).mtimeMs }
        break
      } catch {
        // Not in this folder.
      }
    }
    if (!found) return
    if (row?.state === 'expired' && found.writtenAt <= row.updated_at) return
    if (!(await this.memberLoginConnected(provider, found.home))) return
    this.upsert(seat, provider, { state: 'connected', method: 'login', error: null, connectedAt: this.now() })
    log.info('seat_login_adopted', { seat: userId, provider })
    // Names the member folder, as a sign-in here would have; a login already under the user id keeps that folder.
    this.userHome(seat, provider)
    await this.announce(seat, provider)
  }

  private row(seat: Seat, provider: SeatProvider): SeatRow | null {
    const key = rowKey(seat, provider)
    const cached = this.rows.get(key)
    if (cached !== undefined) return cached
    const row = seatRowSchema.nullish().parse(
      this.deps.db.prepare('SELECT * FROM provider_seat WHERE user_id = ? AND provider = ?').get(seatKey(seat), provider),
    ) ?? null
    this.rows.set(key, row)
    return row
  }

  private deleteRow(seat: Seat, provider: SeatProvider): void {
    this.deps.db.prepare('DELETE FROM provider_seat WHERE user_id = ? AND provider = ?').run(seatKey(seat), provider)
    this.rows.set(rowKey(seat, provider), null)
  }

  private upsert(seat: Seat, provider: SeatProvider, next: { state: SeatRow['state']; method?: 'login' | 'token'; error: string | null; connectedAt?: number }): void {
    const userId = seat.kind === 'host-login' ? HOST_LOGIN_ROW_ID : seatUserIdSchema.parse(seatKey(seat))
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
    // The upsert keeps a stored connected_at; read the row back on next use.
    this.rows.delete(rowKey(seat, provider))
  }

  private async announce(seat: Seat, provider: SeatProvider, error?: string): Promise<SeatStatus> {
    const status = await this.status(seat, provider)
    const event: SeatChangedEvent = { seat, provider, state: status.state }
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

/**
 * A table made before a provider was added keeps the old CHECK, which refuses
 * that provider's rows. SQLite cannot change a CHECK, so the table is copied
 * into one made from the current schema, once, in one transaction.
 */
function allowEverySeatProvider(db: DatabaseSync): void {
  const table = z.object({ sql: z.string() }).nullish().parse(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_seat'").get(),
  )
  if (!table || SEAT_PROVIDERS.every((provider) => table.sql.includes(`'${provider}'`))) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA.replace('CREATE TABLE IF NOT EXISTS provider_seat (', 'CREATE TABLE provider_seat_next ('))
    db.exec('INSERT INTO provider_seat_next SELECT user_id, provider, state, method, error, connected_at, last_used_at, updated_at FROM provider_seat')
    db.exec('DROP TABLE provider_seat')
    db.exec('ALTER TABLE provider_seat_next RENAME TO provider_seat')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  log.info('seat_table_providers_widened', { providers: SEAT_PROVIDERS.length })
}

/** The files a provider keeps its login in, inside a seat directory. */
export function credentialFiles(provider: SeatProvider): readonly string[] {
  return CREDENTIAL_FILES[provider]
}

/** A member's seat directory under the seats root, made 0700 on first use, without its transcript links. */
/** The folder that is `HOME` for a member's processes, beside their seats and named like them. */
export function memberHomeDirectory(seatsRoot: string, seat: Extract<Seat, { kind: 'user' }>): string {
  const folder = seatUserIdSchema.parse(memberFolderFor(seatUserIdSchema.parse(seatKey(seat)), seat.name))
  return join(seatsRoot, 'home', folder)
}

export function memberSeatDirectory(seatsRoot: string, folder: string, provider: SeatProvider): string {
  const safeFolder = seatUserIdSchema.parse(folder)
  ensureDir(seatsRoot, 0o700)
  ensureSeatShims(seatsRoot)
  const level = join(seatsRoot, SEAT_FOLDERS[provider])
  ensureDir(level, 0o700)
  const home = join(level, safeFolder)
  ensureDir(home, 0o700)
  return home
}

/** The `bin` beside the seats whose `open` and `xdg-open` fail: a relayed login prints its URL instead. */
export function ensureSeatShims(seatsRoot: string): string {
  const bin = join(seatsRoot, 'bin')
  // Where each member is their own user, their relayed login runs as them and must run the shims too.
  const mode = memberUsers() ? 0o755 : 0o700
  ensureDir(bin, mode)
  for (const name of ['open', 'xdg-open']) {
    const path = join(bin, name)
    if (!existsSync(path)) writeFileSync(path, '#!/bin/sh\n# Solus seat shim: a relayed login must not open a browser on the host.\nexit 1\n', { mode })
    chmodSync(path, mode)
  }
  // agy's browser for a Gemini Enterprise sign-in: it prints the link for Solus to relay.
  const browser = join(bin, ANTIGRAVITY_BROWSER_HELPER)
  writeFileSync(browser, `#!/bin/sh\n# Solus seat shim: print the sign-in link instead of opening it.\nprintf '%s%s\\n' '${ANTIGRAVITY_BROWSER_MARKER}' "$1" >&2\n`, { mode })
  chmodSync(browser, mode)
  return bin
}

/** The name of agy's browser helper in the seats' `bin`. */
export const ANTIGRAVITY_BROWSER_HELPER = 'solus-agy-browser'

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

/** The OS user a seat's files are written as: the member's on a host where each member is a user; null elsewhere and for the host login. */
function processUserOf(seat: Seat): ProcessUser | null {
  return seat.kind === 'host-login' ? null : identityFor(seat).processUser()
}
