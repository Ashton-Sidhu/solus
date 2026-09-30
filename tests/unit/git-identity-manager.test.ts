import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, runAsync } from '@solus/server/git/exec'
import { GitIdentityManager, type GitIdentity, type MemberGithubToken } from '@solus/server/git/git-identity-manager'
import { GITHUB_CREDENTIAL_KEY } from '@solus/server/providers/github/git-credential'

/**
 * On a host several people use, a member's Git work must commit as the member
 * and authenticate as the member, and a member with no usable identity must
 * never fall back to the host's author or credentials.
 */

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-git-identity-'))
  directories.push(directory)
  return directory
}

/** A host whose account service answers from `accounts`, and a checkout set up with the host's identity and helper. */
function host() {
  const root = temporaryDirectory()
  const accounts = new Map<string, MemberGithubToken | Error>()
  const reads: string[] = []
  let now = 0
  const identities = new GitIdentityManager({
    memberToken: async (userId) => {
      reads.push(userId)
      const answer = accounts.get(userId)
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
    fetchLogin: async () => { throw new Error('every test token names its login') },
    credentialsDir: join(root, 'git-credentials'),
    now: () => now,
  })
  const checkout = join(root, 'checkout')
  git(['init', '-b', 'main', checkout], root)
  git(['config', 'user.name', 'Host'], checkout)
  git(['config', 'user.email', 'host@example.invalid'], checkout)
  // If the host's helpers are ever asked, they leave a mark and answer with the host's token.
  const hostHelperMark = join(root, 'host-helper-called')
  const hostHelper = `!f() { touch '${hostHelperMark}'; printf 'username=host\\npassword=host-token\\n'; }; f`
  git(['config', 'credential.helper', hostHelper], checkout)
  git(['config', GITHUB_CREDENTIAL_KEY, hostHelper], checkout)
  return { root, accounts, reads, identities, checkout, hostHelperMark, advance: (ms: number) => { now += ms } }
}

/** What git itself would send to GitHub, through a fresh helper process, for a process with `identity`. */
async function githubPassword(checkout: string, identity: GitIdentity): Promise<string | null> {
  if (identity.kind === 'host') throw new Error('the host identity has no environment')
  try {
    const answer = await runAsync('sh', ['-c', "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill"], checkout, { env: identity.env })
    return answer.split('\n').find((line) => line.startsWith('password='))?.slice('password='.length) ?? null
  } catch {
    return null
  }
}

test('the host login acts as the host, keeping the checkout configuration', async () => {
  const { identities, reads } = host()
  expect(await identities.resolve({ kind: 'host-login' })).toEqual({ kind: 'host' })
  expect(reads).toEqual([])
})

test('two members commit and authenticate as themselves, never as each other or the host', async () => {
  const { accounts, identities, checkout, hostHelperMark } = host()
  accounts.set('alice', { accessToken: 'alice-token', login: 'alice-gh' })
  accounts.set('bob', { accessToken: 'bob-token', login: 'bob-gh' })
  const alice = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })
  const bob = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } })
  if (alice.kind !== 'member' || bob.kind !== 'member') throw new Error('both members have GitHub connected')
  const releaseAlice = identities.hold(alice)
  const releaseBob = identities.hold(bob)

  await runAsync('git', ['commit', '--allow-empty', '-m', 'Alice'], checkout, { env: alice.env })
  expect(git(['log', '-1', '--format=%an <%ae> / %cn'], checkout)).toBe('alice-gh <alice-gh@users.noreply.github.com> / alice-gh')
  expect(await githubPassword(checkout, alice)).toBe('alice-token')
  expect(await githubPassword(checkout, bob)).toBe('bob-token')
  expect(existsSync(hostHelperMark)).toBe(false)
  expect(alice.revision).not.toBe(bob.revision)
  // The token is in neither the environment nor argv.
  expect(JSON.stringify(alice.env)).not.toContain('alice-token')

  releaseAlice()
  releaseBob()
})

test('a held credential is a 0600 file that exists only while something holds it', async () => {
  const { root, accounts, identities, checkout } = host()
  accounts.set('alice', { accessToken: 'alice-token', login: 'alice-gh' })
  const alice = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })
  if (alice.kind !== 'member') throw new Error('alice has GitHub connected')
  const file = join(root, 'git-credentials', `alice-${alice.revision}`)
  expect(existsSync(file)).toBe(false)
  const first = identities.hold(alice)
  const second = identities.hold(alice)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  first()
  first()
  expect(await githubPassword(checkout, alice)).toBe('alice-token')
  second()
  expect(existsSync(file)).toBe(false)
  // Released, the helper answers nothing, and with prompts off git fails instead of asking the host.
  expect(await githubPassword(checkout, alice)).toBeNull()
})

test('a member without GitHub cannot commit or push as the host, but the host helper is never asked', async () => {
  const { identities, checkout, hostHelperMark } = host()
  const bob = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } })
  expect(bob).toMatchObject({ kind: 'unavailable', userId: 'bob', reason: expect.stringContaining('Connect GitHub') })
  if (bob.kind !== 'unavailable') throw new Error('bob has no GitHub connection')

  await expect(runAsync('git', ['commit', '--allow-empty', '-m', 'Bob'], checkout, { env: bob.env })).rejects.toThrow('empty ident name')
  expect(() => git(['log', '-1'], checkout)).toThrow()
  expect(await githubPassword(checkout, bob)).toBeNull()
  expect(existsSync(hostHelperMark)).toBe(false)
})

test('an account-service failure is unavailable, not the host, and is asked again next time', async () => {
  const { accounts, identities, reads } = host()
  accounts.set('alice', new Error('account service down'))
  expect(await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('account service down') })
  accounts.set('alice', { accessToken: 'alice-token', login: 'alice-gh' })
  expect(await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })).toMatchObject({ kind: 'member', name: 'alice-gh' })
  expect(reads).toEqual(['alice', 'alice'])
})

test('a changed account is a new revision; a process on the old one keeps its own token', async () => {
  const { accounts, identities, checkout, reads, advance } = host()
  accounts.set('alice', { accessToken: 'work-token', login: 'alice-work' })
  const before = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })
  if (before.kind !== 'member') throw new Error('alice has GitHub connected')
  const releaseBefore = identities.hold(before)

  accounts.set('alice', { accessToken: 'personal-token', login: 'alice-personal' })
  // Within the answer's lifetime the account service is not asked again.
  expect(await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })).toBe(before)
  advance(5 * 60_000)
  const after = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })
  if (after.kind !== 'member') throw new Error('alice has GitHub connected')
  expect(reads).toEqual(['alice', 'alice'])
  expect(after.revision).not.toBe(before.revision)

  const releaseAfter = identities.hold(after)
  // An old author never meets the new account's token.
  expect(await githubPassword(checkout, before)).toBe('work-token')
  expect(await githubPassword(checkout, after)).toBe('personal-token')
  releaseBefore()
  releaseAfter()
})

test('a renewed token for the same account reaches the process already holding it', async () => {
  const { accounts, identities, checkout, advance } = host()
  accounts.set('alice', { accessToken: 'old-token', login: 'alice-gh' })
  const first = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })
  const release = identities.hold(first)
  accounts.set('alice', { accessToken: 'new-token', login: 'alice-gh' })
  advance(5 * 60_000)
  const second = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })
  if (first.kind !== 'member' || second.kind !== 'member') throw new Error('alice has GitHub connected')
  expect(second.revision).toBe(first.revision)
  expect(await githubPassword(checkout, first)).toBe('new-token')
  release()
})

test('revoking a member removes their held credential at once', async () => {
  const { root, accounts, identities, checkout } = host()
  accounts.set('alice', { accessToken: 'alice-token', login: 'alice-gh' })
  const alice = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } })
  if (alice.kind !== 'member') throw new Error('alice has GitHub connected')
  const release = identities.hold(alice)
  identities.revoke('alice')
  expect(existsSync(join(root, 'git-credentials', `alice-${alice.revision}`))).toBe(false)
  expect(await githubPassword(checkout, alice)).toBeNull()
  release()
})

test('an id that could reach a shell is never given a credential', async () => {
  const { accounts, identities, reads } = host()
  accounts.set("x'; rm -rf ~", { accessToken: 't', login: 'x' })
  expect(await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: "x'; rm -rf ~" } })).toMatchObject({ kind: 'unavailable' })
  expect(reads).toEqual([])
})

test('a credential left by an earlier server process is removed at start', () => {
  const root = temporaryDirectory()
  const credentialsDir = join(root, 'git-credentials')
  new GitIdentityManager({ memberToken: async () => null, fetchLogin: async () => '', credentialsDir, now: () => 0 })
  writeFileSync(join(credentialsDir, 'alice-stale'), 'old-token')
  new GitIdentityManager({ memberToken: async () => null, fetchLogin: async () => '', credentialsDir, now: () => 0 })
  expect(existsSync(join(credentialsDir, 'alice-stale'))).toBe(false)
  expect(statSync(credentialsDir).mode & 0o777).toBe(0o700)
})

test('a Solus commit for a member without an identity is refused before git runs', async () => {
  // WHY: the action runs in the server process, which has the host's author;
  // without the refusal the member's commit would be the host's.
  const { identities, checkout } = host()
  const { runGitAction } = await import('@solus/server/git/git-action-manager')
  git(['commit', '--allow-empty', '-m', 'Base'], checkout)
  writeFileSync(join(checkout, 'change.txt'), 'member work')
  const bob = await identities.resolve({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } })
  const run = runGitAction(
    { actionId: 'a1', action: 'commit', commitMessage: 'Member work' },
    { branch: 'main', targetBranch: 'main' },
    checkout,
    {
      identity: bob,
      holdIdentity: (identity) => identities.hold(identity),
      generateCommitSubject: async () => 'unused',
      publish: () => {},
      writer: { provider: 'codex', textGenerator: { generate: async () => '' }, instructions: '', followPullRequestTemplate: false },
    },
  )
  await expect(run).rejects.toThrow('Connect GitHub')
  expect(git(['log', '--format=%s'], checkout)).toBe('Base')
})
