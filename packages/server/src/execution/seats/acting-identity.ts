import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { parseUserKey, userKey } from '@solus/contracts/user'
import { credentialUserFor, seatFor, type Actor } from '../../admission/actor'
import { getCliPath, hostCliEnv } from '../../cli-env'
import { createLogger } from '../../logger'
import { MEMBER_GITHUB_FILE } from '../../providers/github/git-credential'
import { useActingScopeSource, useDefaultActingScopeForTests, withActingScope, type ActingScope, type ActingScopeSource } from '../../vault/acting-scope'

const log = createLogger('main', 'acting-identity')

/**
 * Whose credentials a process uses (plans/019-acting-identity.md): the host
 * login, or one member. A member's processes run in a clean environment whose
 * `HOME` is their own folder, so git, `gh`, ssh and the provider CLIs find the
 * member's configuration and nothing of the host's: no key, no helper, no
 * token. This prevents mistakes, not attacks — every process still runs as the
 * host's OS user (decision 9).
 */

/** How long one answer about a member's GitHub connection stands. Bounds how late a reconnected account is noticed. */
const GITHUB_ANSWER_TTL_MS = 5 * 60_000

/** The host variables a member's process keeps. Everything else, credentials included, stays with the host. */
const MEMBER_PASSED_VARIABLES = [
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TERM', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'SOLUS_DEV_LOG',
] as const

/** The member's GitHub connection as git and `gh` use it. */
export type MemberGithub =
  | { kind: 'connected'; token: string; login: string }
  | { kind: 'unavailable'; reason: string }

export interface ActingIdentitiesDeps {
  /** The member's GitHub token through their account connection; null when they have not connected GitHub. */
  memberToken: (credentialUserId: string) => Promise<{ accessToken: string; login?: string } | null>
  fetchLogin: (accessToken: string) => Promise<string>
  /** The folder that is `HOME` for a member's processes. */
  memberHome: (seat: Extract<Seat, { kind: 'user' }>) => string
  /** The Solus git helper as a git `credential.helper` value, or null when this host has none to offer. */
  gitHelper: () => string | null
  now: () => number
}

export class ActingIdentity {
  /** Keys caches and shared in-flight work: `host`, or the member's user key. */
  readonly cacheKey: string
  private answer: { github: Promise<MemberGithub>; readAt: number } | null = null
  /** The last settled answer, so a synchronous environment can name the author once it is known. */
  private settled: MemberGithub | null = null
  private homeWritten = false

  constructor(readonly seat: Seat, private readonly deps: ActingIdentitiesDeps | null) {
    this.cacheKey = seat.kind === 'host-login' ? 'host' : userKey(seat.userId)
  }

  get isHost(): boolean {
    return this.seat.kind === 'host-login'
  }

  /**
   * A member's GitHub connection: read once, shared by concurrent callers, and
   * written to the member home as it is read. Null for the host, whose git and
   * `gh` keep the host's own configuration.
   */
  github(): Promise<MemberGithub> | null {
    const { seat, deps } = this
    if (seat.kind === 'host-login' || !deps) return null
    const held = this.answer
    if (held && deps.now() - held.readAt < GITHUB_ANSWER_TTL_MS) return held.github
    const github = this.readGithub(seat, deps)
    this.answer = { github, readAt: deps.now() }
    return github
  }

  /** Why a member may not commit or push, or null when they may. The host always may. */
  async gitUnavailableReason(): Promise<string | null> {
    const github = await this.github()
    return github?.kind === 'unavailable' ? github.reason : null
  }

  /** The child environment, with the member's author once their GitHub connection is read. */
  async env(extra?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    await this.github()
    return this.envSync(extra)
  }

  /**
   * The child environment without waiting. A member's home is written first, so
   * git never reaches a host helper; until their GitHub connection has been
   * read once, the author is absent and a commit fails rather than borrowing
   * an identity.
   */
  envSync(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const { seat, deps } = this
    if (seat.kind === 'host-login' || !deps) return hostCliEnv(extra)
    const home = deps.memberHome(seat)
    if (!this.homeWritten) {
      writeMemberGitConfig(home, deps.gitHelper())
      this.homeWritten = true
    }
    const env: NodeJS.ProcessEnv = {}
    for (const name of MEMBER_PASSED_VARIABLES) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    env.PATH = getCliPath()
    env.HOME = home
    // The system config can name a keychain helper that answers with the host's credentials.
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_TERMINAL_PROMPT = '0'
    // A checkout's own `user.name` outranks `~/.gitconfig`; these outrank both.
    const author = this.settled?.kind === 'connected' ? this.settled.login : ''
    const email = author ? `${author}@users.noreply.github.com` : ''
    env.GIT_AUTHOR_NAME = author
    env.GIT_AUTHOR_EMAIL = email
    env.GIT_COMMITTER_NAME = author
    env.GIT_COMMITTER_EMAIL = email
    // A caller adds variables for one command; it cannot change whose home or author this is.
    return { ...extra, ...env }
  }

  /** Read the member's connection again on next use: their account changed. */
  forget(): void {
    this.answer = null
  }

  /** The member may no longer act here: their credentials leave the disk now. */
  revoke(): void {
    this.answer = null
    this.settled = null
    const { seat, deps } = this
    if (seat.kind === 'host-login' || !deps) return
    removeMemberCredentials(deps.memberHome(seat))
  }

  private async readGithub(seat: Extract<Seat, { kind: 'user' }>, deps: ActingIdentitiesDeps): Promise<MemberGithub> {
    const credentialUserId = userKey(seat.userId)
    let github: MemberGithub
    try {
      const token = await withActingScope({ identity: this, credentialUserId }, () => deps.memberToken(credentialUserId))
      github = token
        ? { kind: 'connected', token: token.accessToken, login: token.login ?? await deps.fetchLogin(token.accessToken) }
        : { kind: 'unavailable', reason: 'Connect GitHub to your Solus account to commit and push on this host.' }
    } catch (error) {
      // A failed read is not remembered: the next use asks again.
      this.answer = null
      github = { kind: 'unavailable', reason: `Your GitHub connection could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
    const home = deps.memberHome(seat)
    if (github.kind === 'connected') writeMemberCredentials(home, github)
    else {
      removeMemberCredentials(home)
      log.warn('member_github_unavailable', { userId: credentialUserId, reason: github.reason })
    }
    this.settled = github
    return github
  }
}

/** The host's own identity: the environment the host process runs with. */
export const HOST_IDENTITY = new ActingIdentity(HOST_LOGIN_SEAT, null)

/** The host acting for itself, with its own account connections. */
export const HOST_SCOPE: ActingScope = { identity: HOST_IDENTITY, credentialUserId: null }

/** One identity object for each seat, for the life of the server. */
export class ActingIdentities implements ActingScopeSource {
  readonly host = HOST_IDENTITY
  private readonly members = new Map<string, ActingIdentity>()

  constructor(private readonly deps: ActingIdentitiesDeps) {}

  /** A map read: no I/O, and the same object for a seat every time. */
  for(seat: Seat): ActingIdentity {
    if (seat.kind === 'host-login') return this.host
    const key = userKey(seat.userId)
    let identity = this.members.get(key)
    if (!identity) {
      identity = new ActingIdentity(seat, this.deps)
      this.members.set(key, identity)
    }
    return identity
  }

  /** A member's account changed: their next process reads it again. */
  forget(memberUserKey: string): void {
    this.members.get(memberUserKey)?.forget()
  }

  /** The member may no longer act here: forget them and remove their credentials. */
  revoke(memberUserKey: string): void {
    this.members.get(memberUserKey)?.revoke()
    this.members.delete(memberUserKey)
    log.info('acting_identity_revoked', { userId: memberUserKey })
  }

  /** A person named by user key runs on their own seat with their own connections; null is the host. */
  scopeForUser(memberUserKey: string | null): ActingScope {
    if (memberUserKey === null) return { identity: this.host, credentialUserId: null }
    return { identity: this.for({ kind: 'user', userId: parseUserKey(memberUserKey) }), credentialUserId: memberUserKey }
  }
}

let current: ActingIdentities | null = null

/** Before identities are installed, only the host has a scope: a member's needs their home. */
const hostOnlySource: ActingScopeSource = {
  scopeForUser: (memberUserKey) => memberUserKey === null ? HOST_SCOPE : { identity: installedIdentities().for({ kind: 'user', userId: parseUserKey(memberUserKey) }), credentialUserId: memberUserKey },
}

/** Installed once at boot, as `useMemberFolders` is; a test installs its own. */
export function useActingIdentities(identities: ActingIdentities | null): void {
  current = identities
  useActingScopeSource(identities ?? hostOnlySource)
}

function installedIdentities(): ActingIdentities {
  if (!current) throw new Error('Acting identities are not installed on this server.')
  return current
}

useActingScopeSource(hostOnlySource)

/** Runs `fn` as an actor: their seat's processes and their account connections. */
export function withActorScope<T>(actor: Actor, fn: () => T): T {
  const credentialUser = credentialUserFor(actor)
  return withActingScope({
    identity: identityFor(seatFor(actor)),
    credentialUserId: credentialUser ? userKey(credentialUser) : null,
  }, fn)
}

/** Runs `fn` as the host itself: work no person asked for. */
export function withHostScope<T>(fn: () => T): T {
  return withActingScope(HOST_SCOPE, fn)
}

/**
 * Tests only: a call with no scope in this test file runs as the host. A test of
 * a git or process helper calls it to say whose work it is; a test of an edge
 * does not, so a missing scope still fails there.
 */
export function actAsHostForTests(): void {
  useDefaultActingScopeForTests(HOST_SCOPE)
}

/** The identity of a seat, from the installed identities. */
export function identityFor(seat: Seat): ActingIdentity {
  return seat.kind === 'host-login' ? HOST_IDENTITY : installedIdentities().for(seat)
}

// ── The member home ─────────────────────────────────────────────────────────

const GH_HOSTS_FILE = ['.config', 'gh', 'hosts.yml'] as const

/**
 * `~/.gitconfig` for a member. The empty helper clears any helper a config
 * read earlier named; the Solus git helper answers first; `gh` answers only
 * when it is installed and the member signed it in; the last helper says
 * `quit`, so git never asks a helper from the checkout's own config, such as a
 * paired device's in a dispatch checkout.
 */
export function memberGitConfig(gitHelper: string | null): string {
  const helpers = [
    '\thelper =',
    ...(gitHelper ? [`\thelper = ${gitConfigValue(gitHelper)}`] : []),
    `\thelper = ${gitConfigValue('!f() { command -v gh >/dev/null 2>&1 && gh auth git-credential "$@"; }; f')}`,
    `\thelper = ${gitConfigValue('!f() { echo quit=1; }; f')}`,
  ]
  return [
    '# Written by Solus for this member. Changes are replaced.',
    '[credential]',
    ...helpers,
    '[url "https://github.com/"]',
    '\tinsteadOf = git@github.com:',
    '\tinsteadOf = ssh://git@github.com/',
    '',
  ].join('\n')
}

/** A git config value in double quotes, so `;` and `#` in a shell helper stay part of it. */
function gitConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function writeMemberGitConfig(home: string, gitHelper: string | null): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeIfChanged(join(home, '.gitconfig'), memberGitConfig(gitHelper), 0o600)
}

/** The Solus git helper reads the first file; `gh` an agent runs reads the second. */
function writeMemberCredentials(home: string, github: Extract<MemberGithub, { kind: 'connected' }>): void {
  writeIfChanged(join(home, ...MEMBER_GITHUB_FILE), `${JSON.stringify({ token: github.token, login: github.login })}\n`, 0o600)
  writeIfChanged(join(home, ...GH_HOSTS_FILE), [
    'github.com:',
    '    users:',
    `        ${github.login}:`,
    `            oauth_token: ${github.token}`,
    '    git_protocol: https',
    `    user: ${github.login}`,
    `    oauth_token: ${github.token}`,
    '',
  ].join('\n'), 0o600)
}

function removeMemberCredentials(home: string): void {
  rmSync(join(home, ...MEMBER_GITHUB_FILE), { force: true })
  rmSync(join(home, ...GH_HOSTS_FILE), { force: true })
}

function writeIfChanged(path: string, content: string, mode: number): void {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch {
    // Not written yet.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
}
