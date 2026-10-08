import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Seat } from '@solus/contracts/seats'
import { git, runAsync } from '@solus/server/git/exec'
import { gitCommandAuth } from '@solus/server/git/git-auth-env'
import { ActingIdentities, HOST_IDENTITY, withHostScope } from '@solus/server/execution/seats/acting-identity'
import { claudeEnv } from '@solus/server/execution/agents/claude/claude-agent'
import { memberHomeDirectory } from '@solus/server/execution/seats/seat-manager'
import { GITHUB_CREDENTIAL_KEY } from '@solus/server/providers/github/git-credential'
import { withActingScope } from '@solus/server/vault/acting-scope'

/**
 * plans/019-acting-identity.md: on a host several people use, every process a
 * member's work starts acts as that member — their author, their GitHub
 * connection, their home — and nothing the host process carries reaches it: no
 * key agent, no token variable, no helper the host or a checkout configured.
 */

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-acting-identity-'))
  directories.push(directory)
  return directory
}

const repositoryRoot = resolve(import.meta.dir, '../..')

/**
 * The Solus git helper as git runs it on a host: a separate process, started
 * by absolute path, in `--member-home` mode. It reads the member's connection
 * from the `HOME` git was given and from nothing else.
 */
function solusGitHelper(root: string): string {
  const script = join(root, 'solus-git-helper.ts')
  writeFileSync(script, [
    `import { runGitCredentialHelper } from ${JSON.stringify(join(repositoryRoot, 'packages/server/src/providers/github/git-credential.ts'))}`,
    "await runGitCredentialHelper(process.argv[2] === 'get' ? 'get' : 'store', process.stdin, process.stdout, { kind: 'member-home' })",
  ].join('\n'))
  return `!'${process.execPath}' '${script}'`
}

/** A host whose account service answers from `accounts`, and a checkout set up with the host's identity and helper. */
function host() {
  const root = temporaryDirectory()
  const accounts = new Map<string, { accessToken: string; login: string } | Error>()
  const reads: string[] = []
  let now = 0
  const identities = new ActingIdentities({
    memberToken: async (userId) => {
      reads.push(userId)
      const answer = accounts.get(userId)
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
    fetchLogin: async () => { throw new Error('every test token names its login') },
    memberHome: (seat) => memberHomeDirectory(root, seat),
    gitHelper: () => solusGitHelper(root),
    now: () => now,
  })
  const checkout = join(root, 'checkout')
  withHostScope(() => {
    git(['init', '-b', 'main', checkout], root)
    git(['config', 'user.name', 'Host'], checkout)
    git(['config', 'user.email', 'host@example.invalid'], checkout)
  })
  // If a helper the host or the checkout configured is ever asked, it leaves a mark and answers with the host's token.
  const hostHelperMark = join(root, 'host-helper-called')
  const hostHelper = `!f() { touch '${hostHelperMark}'; printf 'username=host\\npassword=host-token\\n'; }; f`
  withHostScope(() => {
    git(['config', 'credential.helper', hostHelper], checkout)
    git(['config', GITHUB_CREDENTIAL_KEY, hostHelper], checkout)
  })
  return { root, accounts, reads, identities, checkout, hostHelperMark, advance: (ms: number) => { now += ms } }
}

const member = (accountId: string): Seat => ({ kind: 'user', userId: { kind: 'account', accountId } })

/** Runs `fn` as a member: their identity and their account connections, as an RPC from them would. */
function asMember<T>(identities: ActingIdentities, accountId: string, fn: () => Promise<T>): Promise<T> {
  return withActingScope({ identity: identities.for(member(accountId)), credentialUserId: accountId }, fn)
}

/** What git itself would send to GitHub, through the helpers a fresh git process finds, in the current scope. */
async function githubPassword(checkout: string): Promise<string | null> {
  try {
    const answer = await runAsync('sh', ['-c', "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill"], checkout)
    return answer.split('\n').find((line) => line.startsWith('password='))?.slice('password='.length) ?? null
  } catch {
    return null
  }
}

test('the host acts as the host: its environment, and no account read', async () => {
  const { identities, reads } = host()
  expect(identities.for({ kind: 'host-login' })).toBe(HOST_IDENTITY)
  expect(HOST_IDENTITY.github()).toBeNull()
  expect((await HOST_IDENTITY.env()).HOME).toBe(process.env.HOME)
  expect(reads).toEqual([])
})

test('two members commit and authenticate as themselves, never as each other or the host', async () => {
  const { accounts, identities, checkout, hostHelperMark } = host()
  accounts.set('alice', { accessToken: 'alice-token', login: 'alice-gh' })
  accounts.set('bob', { accessToken: 'bob-token', login: 'bob-gh' })

  // `runAsync` takes no identity from its caller: the scope decides.
  await asMember(identities, 'alice', () => runAsync('git', ['commit', '--allow-empty', '-m', 'Alice'], checkout))
  const log = await withHostScope(() => runAsync('git', ['log', '-1', '--format=%an <%ae> / %cn'], checkout))
  expect(log).toBe('alice-gh <alice-gh@users.noreply.github.com> / alice-gh')
  expect(await asMember(identities, 'alice', () => githubPassword(checkout))).toBe('alice-token')
  expect(await asMember(identities, 'bob', () => githubPassword(checkout))).toBe('bob-token')
  // Neither the host's global helper nor the checkout's own was asked.
  expect(existsSync(hostHelperMark)).toBe(false)
  // The token is in no process environment and no argument.
  expect(JSON.stringify(await identities.for(member('alice')).env())).not.toContain('alice-token')
})

test('a member’s process carries nothing of the host’s: no key agent, no token, no home', async () => {
  // WHY: a cloud host failed a member's sync with "Host key verification failed"
  // because git ran with the host's environment and SSH setup.
  const { accounts, identities, root } = host()
  accounts.set('alice', { accessToken: 'alice-token', login: 'alice-gh' })
  const hostSecrets = { SSH_AUTH_SOCK: '/tmp/host-agent.sock', GH_TOKEN: 'host-gh', GITHUB_TOKEN: 'host-github', ANTHROPIC_API_KEY: 'host-anthropic', OPENAI_API_KEY: 'host-openai', GIT_ASKPASS: '/host/askpass' }
  const saved = Object.fromEntries(Object.keys(hostSecrets).map((name) => [name, process.env[name]]))
  Object.assign(process.env, hostSecrets)
  try {
    const env = await identities.for(member('alice')).env({ HOME: '/caller/cannot/change/this' })
    for (const name of Object.keys(hostSecrets)) expect(env[name]).toBeUndefined()
    expect(env.HOME).toBe(join(root, 'home', 'alice'))
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.PATH).toBeTruthy()
    // A member's Claude turn starts from the same clean environment.
    const claude = claudeEnv({ home: join(root, 'claude-seat'), env })
    for (const name of Object.keys(hostSecrets)) expect(claude[name]).toBeUndefined()
    expect(claude.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude-seat'))
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('a member without GitHub cannot commit or authenticate, and no host helper answers for them', async () => {
  const { identities, checkout, hostHelperMark } = host()
  const bob = identities.for(member('bob'))
  expect(await bob.gitUnavailableReason()).toContain('Connect GitHub')
  await expect(asMember(identities, 'bob', () => runAsync('git', ['commit', '--allow-empty', '-m', 'Bob'], checkout))).rejects.toThrow('empty ident name')
  expect(await asMember(identities, 'bob', () => githubPassword(checkout))).toBeNull()
  expect(existsSync(hostHelperMark)).toBe(false)
})

test('a Solus commit for a member without GitHub is refused before git runs', async () => {
  // WHY: the action runs in the server process, which has the host's author;
  // without the refusal the member's commit would be the host's.
  const { identities, checkout } = host()
  const { runGitAction } = await import('@solus/server/git/git-action-manager')
  await withHostScope(() => runAsync('git', ['commit', '--allow-empty', '-m', 'Base'], checkout))
  writeFileSync(join(checkout, 'change.txt'), 'member work')
  const run = asMember(identities, 'bob', () => runGitAction(
    { actionId: 'a1', action: 'commit', commitMessage: 'Member work' },
    { branch: 'main', targetBranch: 'main' },
    checkout,
    {
      generateCommitSubject: async () => 'unused',
      publish: () => {},
      writer: { backend: { provider: 'codex', model: 'gpt-6-luna' }, textGenerator: { generate: async () => '' }, instructions: '', followPullRequestTemplate: false },
    },
  ))
  await expect(run).rejects.toThrow('Connect GitHub')
  expect(await withHostScope(() => runAsync('git', ['log', '--format=%s'], checkout))).toBe('Base')
})

test('concurrent processes share one account read, and it is asked again after its lifetime or a failure', async () => {
  const { accounts, identities, reads, advance } = host()
  accounts.set('alice', new Error('account service down'))
  const alice = identities.for(member('alice'))
  expect(await alice.gitUnavailableReason()).toContain('account service down')
  accounts.set('alice', { accessToken: 'alice-token', login: 'alice-gh' })
  // A failure is not remembered.
  await Promise.all([alice.env(), alice.env(), alice.env()])
  expect(reads).toEqual(['alice', 'alice'])
  advance(5 * 60_000)
  await alice.env()
  expect(reads).toEqual(['alice', 'alice', 'alice'])
})

test('a renewed token reaches a process that is already running, and revoking removes it at once', async () => {
  const { accounts, identities, checkout, root, advance } = host()
  accounts.set('alice', { accessToken: 'old-token', login: 'alice-gh' })
  expect(await asMember(identities, 'alice', () => githubPassword(checkout))).toBe('old-token')
  accounts.set('alice', { accessToken: 'new-token', login: 'alice-gh' })
  advance(5 * 60_000)
  await identities.for(member('alice')).env()
  expect(await asMember(identities, 'alice', () => githubPassword(checkout))).toBe('new-token')
  const tokenFile = join(root, 'home', 'alice', '.config', 'solus', 'github.json')
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600)

  identities.revoke('alice')
  expect(existsSync(tokenFile)).toBe(false)
  expect(existsSync(join(root, 'home', 'alice', '.config', 'gh', 'hosts.yml'))).toBe(false)
})

test('a caller’s chosen token is the host’s alone; a member’s git answers from their home', () => {
  const { identities } = host()
  const hostAuth = withHostScope(() => gitCommandAuth({ isHttps: true, token: 'chosen' }))
  expect(hostAuth.args.slice(0, 2)).toEqual(['-c', 'credential.helper='])
  expect(hostAuth.env.SOLUS_GIT_TOKEN).toBe('chosen')
  // For a member the override would clear their own helpers, so there is none.
  const memberAuth = withActingScope({ identity: identities.for(member('alice')), credentialUserId: 'alice' }, () => gitCommandAuth({ isHttps: true, token: 'chosen' }))
  expect(memberAuth).toEqual({ args: [], env: {} })
})

test('an id that could reach the filesystem or a shell gets no home', () => {
  const { identities } = host()
  expect(() => identities.for(member("x'; rm -rf ~")).envSync()).toThrow()
})

test('two members never share a review checkout their own connections fetched; the host keeps its path', async () => {
  // WHY: a checkout holds what one person's connection could read. Another
  // member reading it would see a private repository they cannot reach.
  const { identities } = host()
  const { managedPrCheckoutPath } = await import('@solus/server/review/managed-pr-checkout')
  const repo = { host: 'github.com', owner: 'acme', repo: 'private' }
  const target = { kind: 'pr' as const, ...repo, number: 7, baseSha: 'base', headSha: 'head' }
  const pathAs = (accountId: string | null) => accountId === null
    ? withHostScope(() => managedPrCheckoutPath(repo, target, '/checkouts'))
    : withActingScope({ identity: identities.for(member(accountId)), credentialUserId: accountId }, () => managedPrCheckoutPath(repo, target, '/checkouts'))
  expect(pathAs('alice')).not.toBe(pathAs('bob'))
  expect(pathAs('alice')).not.toBe(pathAs(null))
  expect(pathAs('alice')).toBe(pathAs('alice'))
  // The host's path is the one earlier versions made, so its existing checkouts are reused.
  const { createHash } = await import('node:crypto')
  expect(pathAs(null)).toBe(join('/checkouts', createHash('sha256').update('github.com/acme/private/7/base/head').digest('hex')))
})
