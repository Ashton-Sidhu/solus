import { afterEach, expect, test } from 'bun:test'
import './helpers/member-switch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Seat } from '@solus/contracts/seats'
import { launchedProcess, launchOptions, type ProcessUser } from '@solus/server/cli-env'
import { ActingIdentities, HOST_IDENTITY } from '@solus/server/execution/seats/acting-identity'
import { claudeLaunch } from '@solus/server/execution/agents/claude/claude-agent'
import { memberHomeDirectory } from '@solus/server/execution/seats/seat-manager'
import { withActingScope } from '@solus/server/vault/acting-scope'

/**
 * docs/plans/member-isolation.md §3: every process started for a person gets its
 * environment and, on a shared host, its OS user from one launch point. If the
 * user came from anywhere else, a member's agent could run as the server's user
 * and read every other member's seat.
 */

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const member = (accountId: string): Extract<Seat, { kind: 'user' }> => ({ kind: 'user', userId: { kind: 'account', accountId } })

/** A host whose members run as `users` (a shared host), or as the server's user when it is omitted. */
function host(users?: Map<string, ProcessUser>) {
  const root = mkdtempSync(join(tmpdir(), 'solus-launch-point-'))
  directories.push(root)
  return new ActingIdentities({
    memberToken: async () => null,
    fetchLogin: async () => { throw new Error('no member here has GitHub') },
    memberHome: (seat) => memberHomeDirectory(root, seat),
    gitHelper: () => null,
    now: () => 0,
    ...(users && { memberUser: (seat: Extract<Seat, { kind: 'user' }>) => users.get(seat.userId.kind === 'account' ? seat.userId.accountId : '') ?? null }),
  })
}

test('on a shared host a member’s process runs as their own user, with their own home', async () => {
  const identities = host(new Map([['alice', { uid: 20001 }], ['bob', { uid: 20002 }]]))
  const alice = identities.for(member('alice'))
  const bob = identities.for(member('bob'))

  const aliceLaunch = await alice.launchOptions()
  expect(aliceLaunch.user).toEqual({ uid: 20001 })
  expect(aliceLaunch.env.HOME).toContain('alice')
  expect(bob.launchOptionsSync().user).toEqual({ uid: 20002 })
  // The free function follows the acting scope, so a caller cannot pick another person's user.
  expect(withActingScope({ identity: bob, personKey: 'bob' }, () => launchOptions()).user).toEqual({ uid: 20002 })
})

test('the host’s own work never takes a member’s user', () => {
  host(new Map([['alice', { uid: 20001 }]]))
  expect(HOST_IDENTITY.launchOptionsSync().user).toBeUndefined()
})

test('where members share the server’s user, the launch point gives no user', async () => {
  // Every host today, and a personal machine for good: nothing about the spawn changes.
  const launch = await host().for(member('alice')).launchOptions()
  expect(launch.user).toBeUndefined()
  expect(launch.env.HOME).toContain('alice')
})

test('the Claude CLI is spawned as the member only when the seat names a user', () => {
  // WHY: the SDK's own spawn waits for stderr before it reports an exit; replace it only where the user must change.
  expect(claudeLaunch({ home: '/seats/claude/alice' }).spawnClaudeCodeProcess).toBeUndefined()
  expect(claudeLaunch({ home: '/seats/claude/alice', user: { uid: 20001 } }).spawnClaudeCodeProcess).toBeFunction()
})

test('a member\'s process starts through the member switch; every other process starts as it is', () => {
  // WHY: the server holds no capability; only the switch can make a process a member (§2 decision 1).
  const env = { HOME: '/seats/home/alice' }
  const member = launchedProcess({ env, user: { uid: 20001 } }, 'git', ['push'])
  expect(member.file).toEndWith('solus-switch')
  expect(member).toMatchObject({ args: ['20001', '--', 'git', 'push'], env })
  expect(launchedProcess({ env }, 'git', ['push'])).toEqual({ file: 'git', args: ['push'], env })
})
