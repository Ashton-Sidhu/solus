import { afterEach, expect, test } from 'bun:test'
import { MEMBER_SWITCH } from './helpers/member-switch'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Seat } from '@solus/contracts/seats'
import { MemberUsers, useMemberUsers, WorkspacePreparingError, type MemberUser } from '@solus/server/host/member-users'
import { memberFolderFor, memberUserIdOf } from '@solus/server/host/member-folders'
import { applyMemberFiles } from '@solus/server/execution/seats/member-files'
import { ActingIdentities } from '@solus/server/execution/seats/acting-identity'
import { chatFolderFor, projectsRootFor } from '@solus/server/workspace'
import type { Principal } from '@solus/server/admission/principal'

/**
 * docs/plans/member-isolation.md §4–§5: on a managed host the host object makes
 * each member's Linux user and lists it in the users file. The server reads only
 * that file: a member in it runs as their uid, in folders named by their username;
 * a member not in it is not ready and starts nothing, never as the server's user.
 */

const directories: string[] = []
afterEach(() => {
  useMemberUsers(null)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-member-users-'))
  directories.push(directory)
  return directory
}

/** A user the test process may switch to without privilege: itself. */
function ownUser(userId: string, username: string): MemberUser {
  return { userId, username, uid: process.getuid?.() ?? 0, home: `/data/members/${username}`, secrets: `/run/solus-seats/github/${username}` }
}

/** The folders the host object's script names in the file. */
const LAYOUT = { switch: MEMBER_SWITCH, shared: '/data/shared', reviews: '/data/projects/.solus-review' }

function writeUsers(path: string, users: MemberUser[], layout = LAYOUT): void {
  writeFileSync(`${path}.tmp`, JSON.stringify({ layout, users }))
  // The host object's script replaces the file with a rename, as here.
  writeFileSync(path, readFileSync(`${path}.tmp`))
}

const memberPrincipal = (userId: string): Principal => ({ kind: 'org-member', userId, organizationId: 'org-1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Ada Lovelace', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' })

test('a member is ready only once the users file lists them, and leaves when it no longer does', () => {
  const file = join(temporaryDirectory(), 'member-users.json')
  const users = new MemberUsers(file)
  expect(users.userOf('ada1')).toBeNull()

  writeUsers(file, [ownUser('ada1', 'ada-lovelace')])
  expect(users.read()).toMatchObject({ added: [{ userId: 'ada1' }], removed: [], layoutChanged: true })
  expect(users.userOf('ada1')?.username).toBe('ada-lovelace')
  // The server takes its paths from the file: the script that made the folders named them.
  expect(users.layout()).toEqual(LAYOUT)
  expect(users.userOf('ada1')).toMatchObject({ home: '/data/members/ada-lovelace', secrets: '/run/solus-seats/github/ada-lovelace' })

  writeUsers(file, [])
  expect(users.read()).toMatchObject({ added: [], removed: [{ userId: 'ada1' }] })
})

test('a users file that does not parse keeps the last good read', () => {
  // WHY: one bad write must not take every member's user away at once.
  const file = join(temporaryDirectory(), 'member-users.json')
  writeUsers(file, [ownUser('ada1', 'ada-lovelace')])
  const users = new MemberUsers(file)
  writeFileSync(file, '{ not json')
  expect(users.read()).toEqual({ added: [], removed: [], layoutChanged: false })
  expect(users.userOf('ada1')).not.toBeNull()
})

test('on a host with member users, a member’s folder is their username, and an unlisted member has none', () => {
  const file = join(temporaryDirectory(), 'member-users.json')
  writeUsers(file, [ownUser('ada1', 'ada-lovelace')])
  useMemberUsers(new MemberUsers(file))

  expect(memberFolderFor('ada1', 'Ada Lovelace')).toBe('ada-lovelace')
  expect(memberUserIdOf('ada-lovelace')).toBe('ada1')
  expect(() => memberFolderFor('bob1', 'Bob')).toThrow(WorkspacePreparingError)
})

test('a member runs as their own user; one the host object has not made yet starts nothing', () => {
  const root = temporaryDirectory()
  const file = join(root, 'member-users.json')
  const ada = { ...ownUser('ada1', 'ada-lovelace'), uid: 20001 }
  writeUsers(file, [ada])
  const users = new MemberUsers(file)
  useMemberUsers(users)
  const identities = new ActingIdentities({
    memberToken: async () => null,
    fetchLogin: async () => { throw new Error('no GitHub here') },
    memberHome: (seat) => join(root, 'home', memberFolderFor(seat.userId.kind === 'account' ? seat.userId.accountId : '')),
    gitHelper: () => null,
    now: () => 0,
    memberUser: (seat) => {
      const user = users.userOf(seat.userId.kind === 'account' ? seat.userId.accountId : '')
      if (!user) throw new WorkspacePreparingError()
      return { uid: user.uid }
    },
  })
  const member = (accountId: string): Seat => ({ kind: 'user', userId: { kind: 'account', accountId } })

  expect(identities.for(member('ada1')).processUser()).toEqual({ uid: 20001 })
  expect(() => identities.for(member('bob1')).processUser()).toThrow(WorkspacePreparingError)
})

test('files written as the member are theirs, and readable by the server’s group only', () => {
  const home = temporaryDirectory()
  const user = { uid: process.getuid?.() ?? 0 }
  applyMemberFiles(user, [
    { kind: 'write', path: join(home, '.config', 'gh', 'hosts.yml'), content: 'github.com: {}\n', mode: 0o600 },
    { kind: 'folder', path: join(home, 'chat'), mode: 0o750 },
  ])
  expect(readFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'utf8')).toBe('github.com: {}\n')
  // Group read lets the server read back what it wrote; others get nothing.
  expect(statSync(join(home, '.config', 'gh', 'hosts.yml')).mode & 0o777).toBe(0o640)
  expect(statSync(join(home, 'chat')).mode & 0o777).toBe(0o750)

  applyMemberFiles(user, [{ kind: 'remove', path: join(home, '.config', 'gh', 'hosts.yml') }, { kind: 'removeEmptyFolder', path: join(home, '.config', 'gh') }])
  expect(existsSync(join(home, '.config', 'gh'))).toBe(false)
})

test('a member’s chat folder is made as the member, closed to other members; the host object made their projects root', () => {
  const projects = temporaryDirectory()
  const file = join(temporaryDirectory(), 'member-users.json')
  writeUsers(file, [ownUser('ada1', 'ada-lovelace')])
  useMemberUsers(new MemberUsers(file))
  // The host object makes `<projects>/<username>/solus-chats`; the server makes no member folder here.
  expect(projectsRootFor(memberPrincipal('ada1'), projects)).toBe(join(projects, 'ada-lovelace'))
  expect(existsSync(join(projects, 'ada-lovelace'))).toBe(false)
  mkdirSync(join(projects, 'ada-lovelace', 'solus-chats'), { recursive: true })

  const folder = chatFolderFor('chat-1', memberPrincipal('ada1'), projects)
  expect(folder).toBe(join(projects, 'ada-lovelace', 'solus-chats', 'chat-1'))
  expect(statSync(folder).mode & 0o777).toBe(0o750)
  expect(() => chatFolderFor('chat-2', memberPrincipal('bob1'), projects)).toThrow(WorkspacePreparingError)
})

test('what the server hands to members is in the shared folder the users file names; elsewhere nothing moves', async () => {
  // WHY: the server's data folder is closed to members; a skill, an attachment, or a
  // screenshot an agent must open has to be where the member can (member-isolation.md §5).
  const { pluginsDir } = await import('@solus/server/execution/agents/plugins')
  const { agentReadablePath, attachmentFileMode, attachmentsRoot } = await import('@solus/server/data/assets/attachment-store')
  const kept = join(temporaryDirectory(), 'asset-1')
  writeFileSync(kept, 'png')
  expect(await agentReadablePath(kept)).toBe(kept)
  expect(attachmentFileMode()).toBe(0o600)

  const shared = temporaryDirectory()
  mkdirSync(join(shared, 'files'))
  const file = join(temporaryDirectory(), 'member-users.json')
  writeUsers(file, [ownUser('ada1', 'ada-lovelace')], { ...LAYOUT, shared })
  useMemberUsers(new MemberUsers(file))
  expect(pluginsDir()).toBe(join(shared, 'plugins'))
  expect(attachmentsRoot()).toBe(join(shared, 'files'))
  expect(attachmentFileMode()).toBe(0o640)
  const handed = await agentReadablePath(kept)
  expect(handed.startsWith(join(shared, 'files'))).toBe(true)
  expect(readFileSync(handed, 'utf8')).toBe('png')
  expect(statSync(handed).mode & 0o777).toBe(0o640)
  // A random folder a member may enter with the path, and cannot list.
  // Also setgid, so its files keep the members' group; macOS drops that bit for a folder in a group
  // the user is not in, so the Linux container check proves it, not this test.
  expect(statSync(join(handed, '..')).mode & 0o777).toBe(0o710)
})

test('where each member is their own user, their GitHub login is kept out of their home', () => {
  // WHY: the home is in the host's backup; a login must never be (member-isolation.md §5).
  const file = join(temporaryDirectory(), 'member-users.json')
  writeUsers(file, [ownUser('ada1', 'ada-lovelace')])
  const users = new MemberUsers(file)
  useMemberUsers(users)
  const userOf = (seat: Extract<Seat, { kind: 'user' }>) => users.userOf(seat.userId.kind === 'account' ? seat.userId.accountId : '')!
  const identities = new ActingIdentities({
    memberToken: async () => null,
    fetchLogin: async () => { throw new Error('no GitHub here') },
    memberHome: (seat) => userOf(seat).home,
    memberSecrets: (seat) => userOf(seat).secrets,
    gitHelper: () => null,
    now: () => 0,
    memberUser: (seat) => ({ uid: userOf(seat).uid }),
  })
  const env = identities.for({ kind: 'user', userId: { kind: 'account', accountId: 'ada1' } }).envSync()
  expect(env).toMatchObject({ HOME: '/data/members/ada-lovelace', TMPDIR: '/data/members/ada-lovelace/tmp' })
  // gh and the git helper read their defaults in the home, which the host object links to memory:
  // nothing in the environment points anywhere else, as on any machine.
  expect(env.GH_CONFIG_DIR).toBeUndefined()
  expect(Object.values(env).some((value) => value?.includes('/run/solus-seats'))).toBe(false)
})

test('where each member is their own user, their agent CLIs keep their own defaults under HOME', async () => {
  // WHY: the CLI writes its config and transcripts in the member's `~/.claude`, like a normal machine.
  const file = join(temporaryDirectory(), 'member-users.json')
  writeUsers(file, [ownUser('ada1', 'ada-lovelace')])
  const { seatEnv } = await import('@solus/server/execution/seats/seat-login')
  const { claudeEnv } = await import('@solus/server/execution/agents/claude/claude-agent')
  const seatHome = '/run/solus-seats/claude/ada-lovelace'
  expect(seatEnv('claude-code', seatHome)).toEqual({ CLAUDE_CONFIG_DIR: seatHome })
  expect(claudeEnv({ home: seatHome, env: {} }).CLAUDE_CONFIG_DIR).toBe(seatHome)

  useMemberUsers(new MemberUsers(file))
  expect(seatEnv('claude-code', seatHome)).toEqual({})
  expect(seatEnv('codex', '/run/solus-seats/codex/ada-lovelace')).toEqual({})
  expect(claudeEnv({ home: seatHome, env: {}, user: { uid: 20001 } }).CLAUDE_CONFIG_DIR).toBeUndefined()
})
