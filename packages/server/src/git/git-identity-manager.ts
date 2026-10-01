import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Seat } from '@solus/contracts/seats'
import { userKey } from '@solus/contracts/user'
import { createLogger } from '../logger'
import { recordedMemberFolder } from '../host/member-folders'
import { GITHUB_CREDENTIAL_KEY } from '../providers/github/git-credential'

const log = createLogger('main', 'git-identity')

/** How long one answer stands. Bounds how late a reconnected account is noticed, and spares each turn a network read. */
const IDENTITY_TTL_MS = 5 * 60_000

/** The id names a credential file that a shell helper reads, so only plain ids are served. */
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The Git configuration a member's process runs with. The author and committer
 * are the member; every credential helper the host or the checkout configured
 * is cleared, and GitHub asks only the member's own. GitHub over SSH is
 * rewritten to HTTPS, so the host's SSH key does not answer for them either.
 * For an unavailable identity the author is empty and GitHub has no helper, so
 * a commit or push fails clearly while reads and edits still work.
 */
export type GitIdentityEnv = {
  GIT_AUTHOR_NAME: string
  GIT_AUTHOR_EMAIL: string
  GIT_COMMITTER_NAME: string
  GIT_COMMITTER_EMAIL: string
  GIT_TERMINAL_PROMPT: '0'
  GIT_CONFIG_COUNT: '4'
  GIT_CONFIG_KEY_0: 'credential.helper'
  GIT_CONFIG_VALUE_0: ''
  GIT_CONFIG_KEY_1: typeof GITHUB_CREDENTIAL_KEY
  GIT_CONFIG_VALUE_1: string
  GIT_CONFIG_KEY_2: typeof GITHUB_HTTPS_REWRITE_KEY
  GIT_CONFIG_VALUE_2: 'git@github.com:'
  GIT_CONFIG_KEY_3: typeof GITHUB_HTTPS_REWRITE_KEY
  GIT_CONFIG_VALUE_3: 'ssh://git@github.com/'
}

const GITHUB_HTTPS_REWRITE_KEY = 'url.https://github.com/.insteadOf'

/**
 * Who a Git operation acts as. Only `host` inherits the host's and the
 * checkout's own configuration — the paired device's delegated helper in its
 * dispatch checkout included.
 */
export type GitIdentity =
  | { kind: 'host' }
  | { kind: 'member'; userId: string; name: string; email: string; revision: string; env: GitIdentityEnv }
  | { kind: 'unavailable'; userId: string; reason: string; env: GitIdentityEnv }

/** The revision of an unavailable identity: connecting an account changes it. */
export const UNAVAILABLE_REVISION = 'unavailable'

/** What a provider process needs of an identity: its configuration, its revision, and a way to keep its credential readable. */
export interface ProcessGitIdentity {
  revision: string
  env: GitIdentityEnv
  hold(): () => void
}

export interface MemberGithubToken {
  accessToken: string
  login?: string
}

export interface GitIdentityDeps {
  /** The member's GitHub token through their account connection; null when they have not connected GitHub. */
  memberToken: (userId: string) => Promise<MemberGithubToken | null>
  fetchLogin: (accessToken: string) => Promise<string>
  /** Where a held credential lives while a process uses it. Cleared at construction. */
  credentialsDir: string
  now: () => number
}

/**
 * Owns which Git identity an operation acts as, and the lifetime of the
 * credential a member's process reads. A member's token is written to a 0600
 * file only while a process holds it (`hold`), and the file is removed when
 * the last holder releases it; it never reaches argv, env, or checkout config.
 * The file is named by the identity revision, so a process started as one
 * account never reads another account's token.
 */
export class GitIdentityManager {
  private readonly cached = new Map<string, { identity: Promise<GitIdentity>; readAt: number }>()
  /** Credential file → the token it holds. Only tokens this process resolved. */
  private readonly tokens = new Map<string, string>()
  /** Credential file → how many processes or operations hold it. */
  private readonly holders = new Map<string, number>()

  constructor(private readonly deps: GitIdentityDeps) {
    // A file left by an earlier process has no holder.
    rmSync(deps.credentialsDir, { recursive: true, force: true })
    mkdirSync(deps.credentialsDir, { recursive: true, mode: 0o700 })
  }

  /** The identity for a seat: the host login acts as the host, a user as themselves. */
  resolve(seat: Seat): Promise<GitIdentity> {
    if (seat.kind === 'host-login') return Promise.resolve({ kind: 'host' })
    const seatUserId = userKey(seat.userId)
    const held = this.cached.get(seatUserId)
    if (held && this.deps.now() - held.readAt < IDENTITY_TTL_MS) return held.identity
    const identity = this.readMember(seatUserId)
    this.cached.set(seatUserId, { identity, readAt: this.deps.now() })
    return identity
  }

  /** The identity as a provider process takes it; null for the host, whose process inherits the host's configuration. */
  forProcess(identity: GitIdentity): ProcessGitIdentity | null {
    if (identity.kind === 'host') return null
    return {
      revision: identity.kind === 'member' ? identity.revision : UNAVAILABLE_REVISION,
      env: identity.env,
      hold: () => this.hold(identity),
    }
  }

  /**
   * Keep a member's credential readable for one process or operation. Returns
   * the release; the last release removes the file. Host and unavailable
   * identities have no credential to hold.
   */
  hold(identity: GitIdentity): () => void {
    if (identity.kind !== 'member') return () => {}
    const path = this.credentialPath(identity.userId, identity.revision)
    const count = this.holders.get(path) ?? 0
    this.holders.set(path, count + 1)
    if (count === 0) this.writeCredential(path)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.holders.get(path) ?? 1) - 1
      if (remaining > 0) return void this.holders.set(path, remaining)
      this.holders.delete(path)
      rmSync(path, { force: true })
    }
  }

  /** The member may no longer act here: forget their identity and remove every credential of theirs now. */
  revoke(userId: string): void {
    this.cached.delete(userId)
    const prefix = join(this.deps.credentialsDir, `${recordedMemberFolder(userId)}-`)
    for (const path of this.tokens.keys()) {
      if (!path.startsWith(prefix)) continue
      this.tokens.delete(path)
      this.holders.delete(path)
      rmSync(path, { force: true })
    }
    log.info('git_identity_revoked', { userId })
  }

  private async readMember(userId: string): Promise<GitIdentity> {
    if (!SAFE_USER_ID.test(userId) || this.deps.credentialsDir.includes("'")) {
      return this.unavailable(userId, 'This account cannot be given a Git identity on this host.')
    }
    let token: MemberGithubToken | null
    let login: string
    try {
      token = await this.deps.memberToken(userId)
      if (!token) return this.unavailable(userId, 'Connect GitHub to your Solus account to commit and push on this host.')
      login = token.login ?? await this.deps.fetchLogin(token.accessToken)
    } catch (error) {
      this.cached.delete(userId)
      return this.unavailable(userId, `Your GitHub connection could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    const revision = createHash('sha256').update(`${userId}\0${login}`).digest('hex').slice(0, 16)
    const path = this.credentialPath(userId, revision)
    this.tokens.set(path, token.accessToken)
    // A holder keeps reading the file, so a renewed token reaches it too.
    if (this.holders.has(path)) this.writeCredential(path)
    const email = `${login}@users.noreply.github.com`
    return {
      kind: 'member',
      userId,
      name: login,
      email,
      revision,
      env: identityEnv({ name: login, email, helper: credentialHelper(path) }),
    }
  }

  private unavailable(userId: string, reason: string): GitIdentity {
    log.warn('git_identity_unavailable', { userId, reason })
    return { kind: 'unavailable', userId, reason, env: identityEnv({ name: '', email: '', helper: '' }) }
  }

  private credentialPath(userId: string, revision: string): string {
    return join(this.deps.credentialsDir, `${recordedMemberFolder(userId)}-${revision}`)
  }

  private writeCredential(path: string): void {
    const token = this.tokens.get(path)
    if (!token) return
    writeFileSync(path, token, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
}

function identityEnv(input: { name: string; email: string; helper: string }): GitIdentityEnv {
  return {
    GIT_AUTHOR_NAME: input.name,
    GIT_AUTHOR_EMAIL: input.email,
    GIT_COMMITTER_NAME: input.name,
    GIT_COMMITTER_EMAIL: input.email,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '4',
    // An empty value clears every helper git read before it.
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_1: input.helper,
    GIT_CONFIG_KEY_2: GITHUB_HTTPS_REWRITE_KEY,
    GIT_CONFIG_VALUE_2: 'git@github.com:',
    GIT_CONFIG_KEY_3: GITHUB_HTTPS_REWRITE_KEY,
    GIT_CONFIG_VALUE_3: 'ssh://git@github.com/',
  }
}

/**
 * Git runs a `!` helper through the shell with the action appended. It answers
 * `get` from the held file; once the file is gone it answers nothing, and with
 * prompts off git fails rather than asking the host.
 */
function credentialHelper(path: string): string {
  return `!f() { test "$1" = get && test -r '${path}' || return 0; printf 'username=x-access-token\\npassword=%s\\n' "$(cat '${path}')"; }; f`
}
