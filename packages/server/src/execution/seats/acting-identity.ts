import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { parseUserKey, userKey } from '@solus/contracts/user'
import { ownerKeyOf, seatFor, type Actor } from '../../admission/actor'
import { getCliPath, hostCliEnv, type LaunchOptions, type ProcessUser } from '../../cli-env'
import { hostUserKey, isHostUserKey } from '../../host/host-user'
import { createLogger } from '../../logger'
import { MEMBER_GITHUB_FILE } from '../../providers/github/git-credential'
import { applyMemberFiles, type MemberFileChange } from './member-files'
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
  memberToken: (memberKey: string) => Promise<{ accessToken: string; login?: string } | null>
  fetchLogin: (accessToken: string) => Promise<string>
  /** The folder that is `HOME` for a member's processes. */
  memberHome: (seat: Extract<Seat, { kind: 'user' }>) => string
  /**
   * Where a member's GitHub login files are kept apart from their home, in memory,
   * so a backup of the home never holds them (docs/plans/member-isolation.md §5).
   * Absent: they live in the home, as on every host but a managed one.
   */
  memberSecrets?: (seat: Extract<Seat, { kind: 'user' }>) => string
  /** The Solus git helper as a git `credential.helper` value, or null when this host has none to offer. */
  gitHelper: () => string | null
  /**
   * The OS user a member's processes run as on a shared host
   * (docs/plans/member-isolation.md §4); null where they run as the server's
   * own user, as on every host today.
   */
  memberUser?: (seat: Extract<Seat, { kind: 'user' }>) => ProcessUser | null
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
   * The launch point (docs/plans/member-isolation.md §3): the environment and,
   * on a shared host, the member's user for every process started for this
   * identity. Waits for a member's GitHub connection, so their commits name them.
   */
  async launchOptions(extra?: NodeJS.ProcessEnv): Promise<LaunchOptions> {
    return this.withUser(await this.env(extra))
  }

  /** `launchOptions` without waiting: until the GitHub connection is read once, a commit has no author. */
  launchOptionsSync(extra?: NodeJS.ProcessEnv): LaunchOptions {
    return this.withUser(this.envSync(extra))
  }

  private withUser(env: NodeJS.ProcessEnv): LaunchOptions {
    const user = this.processUser()
    return user ? { env, user } : { env }
  }

  /** The member's OS user on a shared host; null for the host and wherever members share the server's user. */
  processUser(): ProcessUser | null {
    const { seat, deps } = this
    if (seat.kind === 'host-login' || !deps?.memberUser) return null
    return deps.memberUser(seat)
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
    // Written again when it is gone: a member who deletes it gets it back at their next process.
    if (!this.homeWritten || !existsSync(join(home, '.gitconfig'))) {
      const user = this.processUser()
      applyMemberFiles(user, [{ kind: 'write', path: join(home, '.gitconfig'), content: memberGitConfig(deps.gitHelper(), { sharedRepositories: user !== null }), mode: 0o600 }])
      this.homeWritten = true
    }
    const env: NodeJS.ProcessEnv = {}
    for (const name of MEMBER_PASSED_VARIABLES) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    env.PATH = getCliPath()
    env.HOME = home
    // Where each member is their own user, their temporary files stay in their home: `/tmp` is shared.
    if (deps.memberSecrets) env.TMPDIR = join(home, 'tmp')
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

  /**
   * The member may no longer act here: their credentials leave the disk now. Where
   * the host object removed their user, it removed their home with it.
   */
  revoke(): void {
    this.answer = null
    this.settled = null
    const { seat, deps } = this
    if (seat.kind === 'host-login' || !deps) return
    let user: ProcessUser | null
    try {
      user = this.processUser()
    } catch {
      return
    }
    applyMemberFiles(user, credentialRemovals(githubFiles(seat, deps)))
  }

  private async readGithub(seat: Extract<Seat, { kind: 'user' }>, deps: ActingIdentitiesDeps): Promise<MemberGithub> {
    const memberKey = userKey(seat.userId)
    let github: MemberGithub
    try {
      const token = await withActingScope({ identity: this, personKey: memberKey }, () => deps.memberToken(memberKey))
      github = token
        ? { kind: 'connected', token: token.accessToken, login: token.login ?? await deps.fetchLogin(token.accessToken) }
        : { kind: 'unavailable', reason: 'Connect GitHub to your Solus account to commit and push on this host.' }
    } catch (error) {
      // A failed read is not remembered: the next use asks again.
      this.answer = null
      github = { kind: 'unavailable', reason: `Your GitHub connection could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
    const files = githubFiles(seat, deps)
    if (github.kind === 'connected') applyMemberFiles(this.processUser(), credentialWrites(files, github))
    else {
      applyMemberFiles(this.processUser(), credentialRemovals(files))
      log.warn('member_github_unavailable', { userId: memberKey, reason: github.reason })
    }
    this.settled = github
    return github
  }
}

/** The host's own identity: the environment the host process runs with. */
export const HOST_IDENTITY = new ActingIdentity(HOST_LOGIN_SEAT, null)

/** The host acting for itself, with its own account connections. */
export const HOST_SCOPE: ActingScope = { identity: HOST_IDENTITY, personKey: null }

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

  /** A person named by user key: the host's user on the host login, anyone else on their own seat; null is the host. */
  scopeForUser(personKey: string | null): ActingScope {
    return scopeFor(personKey, (key) => this.for({ kind: 'user', userId: parseUserKey(key) }))
  }
}

let current: ActingIdentities | null = null

/** Before identities are installed, only the host has a scope: a member's needs their home. */
const hostOnlySource: ActingScopeSource = {
  scopeForUser: (personKey) => scopeFor(personKey, (key) => installedIdentities().for({ kind: 'user', userId: parseUserKey(key) })),
}

/** The scope of a person named by key: the host's user acts on the host login, as `seatFor` puts the owner. */
function scopeFor(personKey: string | null, memberIdentity: (key: string) => ActingIdentity): ActingScope {
  if (personKey === null) return HOST_SCOPE
  if (isHostUserKey(personKey)) return { identity: HOST_IDENTITY, personKey: hostUserKey() }
  return { identity: memberIdentity(personKey), personKey }
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
  return withActingScope({ identity: identityFor(seatFor(actor)), personKey: ownerKeyOf(actor) }, fn)
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
export function memberGitConfig(gitHelper: string | null, options: { sharedRepositories?: boolean } = {}): string {
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
    // Where each member is their own user, members share repositories that another
    // member's user owns, which git refuses without this (docs/plans/member-isolation.md §5).
    ...(options.sharedRepositories ? ['[safe]', '\tdirectory = *'] : []),
    '',
  ].join('\n')
}

/** A git config value in double quotes, so `;` and `#` in a shell helper stay part of it. */
function gitConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Where a member's GitHub login files are written: the Solus git helper reads the first, `gh` the second. */
interface GithubFiles {
  token: string
  hosts: string
}

function githubFiles(seat: Extract<Seat, { kind: 'user' }>, deps: ActingIdentitiesDeps): GithubFiles {
  const secrets = deps.memberSecrets?.(seat)
  if (!secrets) {
    const home = deps.memberHome(seat)
    return { token: join(home, ...MEMBER_GITHUB_FILE), hosts: join(home, ...GH_HOSTS_FILE) }
  }
  // Written to memory; the home's `~/.config/solus/github.json` and `~/.config/gh/hosts.yml`
  // link here (the host object's users script), so gh and the git helper keep their defaults.
  return { token: join(secrets, 'github.json'), hosts: join(secrets, 'gh', 'hosts.yml') }
}

function credentialWrites(files: GithubFiles, github: Extract<MemberGithub, { kind: 'connected' }>): MemberFileChange[] {
  return [
    { kind: 'write', path: files.token, content: `${JSON.stringify({ token: github.token, login: github.login })}\n`, mode: 0o600 },
    {
      kind: 'write',
      path: files.hosts,
      content: [
        'github.com:',
        '    users:',
        `        ${github.login}:`,
        `            oauth_token: ${github.token}`,
        '    git_protocol: https',
        `    user: ${github.login}`,
        `    oauth_token: ${github.token}`,
        '',
      ].join('\n'),
      mode: 0o600,
    },
  ]
}

function credentialRemovals(files: GithubFiles): MemberFileChange[] {
  return [
    { kind: 'remove', path: files.token },
    { kind: 'remove', path: files.hosts },
  ]
}
