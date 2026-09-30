import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SeatProvider } from '@solus/contracts/seats'
import { AGENT_PROFILE_MAX_FILE_BYTES, type AgentProfileBundle } from '@solus/contracts/agent-profile'
import { AgentProfileManager, isProfilePath } from '@solus/server/execution/seats/agent-profile'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-agent-profile-'))
  directories.push(directory)
  return directory
}

function put(root: string, path: string, content: string | Buffer = path): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** A laptop's homes: `~/.claude`, `~/.codex`, and the skills CLI's `~/.agents`. */
function laptop() {
  const root = temporaryDirectory()
  const claude = join(root, '.claude')
  const codex = join(root, '.codex')
  const agents = join(root, '.agents')
  put(claude, 'CLAUDE.md', 'Be brief.')
  put(claude, 'agents/reviewer.md')
  put(claude, 'commands/ship.md')
  put(claude, 'settings.json', '{"secret":true}')
  put(claude, '.credentials.json', 'token')
  put(claude, 'projects/-home/session.jsonl', 'transcript')
  put(agents, 'skills/review/SKILL.md', 'Review skill')
  put(agents, 'skills/review/scripts/run.sh', '#!/bin/sh')
  chmodSync(join(agents, 'skills/review/scripts/run.sh'), 0o755)
  mkdirSync(join(claude, 'skills'), { recursive: true })
  // The skills CLI installs into ~/.agents and links the skill into ~/.claude.
  symlinkSync(join(agents, 'skills/review'), join(claude, 'skills/review'))
  put(claude, 'skills/huge/SKILL.md', Buffer.alloc(AGENT_PROFILE_MAX_FILE_BYTES + 1))
  put(claude, 'skills/node/node_modules/dep/index.js')
  put(codex, 'AGENTS.md', 'Codex rules')
  put(codex, 'skills/review/SKILL.md', 'Codex review skill')
  put(codex, 'skills/.system/builtin/SKILL.md')
  put(codex, 'auth.json', 'token')
  const homes = (provider: SeatProvider) => provider === 'claude-code' ? [claude] : [codex, agents]
  return { homes }
}

const MEMBER = { kind: 'member', userId: 'member-1' } as const
const OWNER = { kind: 'owner' } as const

/** A host with one member's seat homes, reading its own profile from `sourceHomes`. */
function seat(sourceHomes: (provider: SeatProvider) => string[] = () => []) {
  const root = temporaryDirectory()
  const homeFor = (provider: SeatProvider) => {
    const home = join(root, provider === 'claude-code' ? 'claude' : 'codex')
    mkdirSync(home, { recursive: true })
    return home
  }
  let now = 1000
  const profiles = new AgentProfileManager({
    sourceHomes,
    homeFor: (target, provider) => {
      expect([MEMBER, OWNER]).toContainEqual(target)
      return homeFor(provider)
    },
    now: () => now,
  })
  return { root, homeFor, profiles, at: (time: number) => { now = time } }
}

function text(path: string, content: string, provider: SeatProvider = 'claude-code') {
  return { provider, path, contentBase64: Buffer.from(content).toString('base64') }
}

test('a profile carries instructions, skills, subagents, and commands, never logins, settings, or transcripts', () => {
  // WHY: the copy leaves the person's machine; only what shapes how an agent
  // works may go, and a credential must never ride along.
  const { homes } = laptop()
  const bundle = seat(homes).profiles.read()
  const paths = bundle.files.map((file) => `${file.provider}:${file.path}`).sort()
  expect(paths).toEqual([
    'claude-code:CLAUDE.md',
    'claude-code:agents/reviewer.md',
    'claude-code:commands/ship.md',
    'claude-code:skills/review/SKILL.md',
    'claude-code:skills/review/scripts/run.sh',
    'codex:AGENTS.md',
    'codex:skills/review/SKILL.md',
    'codex:skills/review/scripts/run.sh',
  ])
  // Codex's own skill wins over the shared one of the same name.
  const codexSkill = bundle.files.find((file) => file.provider === 'codex' && file.path === 'skills/review/SKILL.md')!
  expect(Buffer.from(codexSkill.contentBase64, 'base64').toString()).toBe('Codex review skill')
  expect(bundle.skipped).toEqual([{ provider: 'claude-code', path: 'skills/huge/SKILL.md', reason: 'file-too-large' }])
})

test('copying again replaces the profile and leaves everything else in the seat alone', () => {
  // WHY: the laptop is the source, so a skill deleted there must go on the host
  // too; the member's login in the same folder must survive every copy.
  const { homes } = laptop()
  const target = seat(homes)
  put(target.homeFor('claude-code'), '.credentials.json', 'member login')
  const bundle = target.profiles.read()
  const first = target.profiles.apply(MEMBER, bundle)
  expect(first).toMatchObject({ syncedAt: 1000, fileCount: bundle.files.length })
  const claudeHome = target.homeFor('claude-code')
  expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe('Be brief.')
  expect(statSync(join(claudeHome, 'skills/review/scripts/run.sh')).mode & 0o100).toBeTruthy()

  const withoutReview = { ...bundle, files: bundle.files.filter((file) => !file.path.startsWith('skills/review')) }
  target.at(2000)
  target.profiles.apply(MEMBER, withoutReview)
  expect(existsSync(join(claudeHome, 'skills/review'))).toBe(false)
  expect(existsSync(join(claudeHome, 'skills'))).toBe(true)
  expect(readFileSync(join(claudeHome, '.credentials.json'), 'utf8')).toBe('member login')

  const removed = target.profiles.remove(MEMBER)
  expect(removed).toEqual({ syncedAt: null, fileCount: 0, skipped: [] })
  expect(existsSync(join(claudeHome, 'CLAUDE.md'))).toBe(false)
  expect(target.profiles.status(MEMBER).syncedAt).toBeNull()
  expect(readFileSync(join(claudeHome, '.credentials.json'), 'utf8')).toBe('member login')
})

test('a path outside the profile is refused before anything is written', () => {
  // WHY: the bundle comes over the network; it must not reach a login file or
  // climb out of the seat.
  const target = seat()
  for (const path of ['.credentials.json', '../escape.md', 'skills/../../x', 'settings.json', '/etc/passwd', 'skills', 'CLAUDE.md/x']) {
    expect(isProfilePath('claude-code', path)).toBe(false)
  }
  const bundle = { files: [text('CLAUDE.md', 'ok'), text('.credentials.json', 'stolen')], skipped: [] }
  expect(() => target.profiles.apply(MEMBER, bundle)).toThrow('is not part of an agent profile')
  expect(existsSync(join(target.homeFor('claude-code'), 'CLAUDE.md'))).toBe(false)
})

test('a file the laptop could not send keeps the copy already in the seat', () => {
  // WHY: an unreadable or oversized source file is not a deletion; only a file
  // the laptop no longer has may go from the seat.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  target.profiles.apply(MEMBER, { files: [text('CLAUDE.md', 'rules'), text('skills/big/SKILL.md', 'v1'), text('agents/old.md', 'old')], skipped: [] })
  const status = target.profiles.apply(MEMBER, {
    files: [text('CLAUDE.md', 'rules')],
    skipped: [{ provider: 'claude-code', path: 'skills/big/SKILL.md', reason: 'file-too-large' }],
  })
  expect(readFileSync(join(claudeHome, 'skills/big/SKILL.md'), 'utf8')).toBe('v1')
  expect(existsSync(join(claudeHome, 'agents/old.md'))).toBe(false)
  expect(status.skipped).toEqual([{ provider: 'claude-code', path: 'skills/big/SKILL.md', reason: 'file-too-large' }])
  // The kept copy is still the profile's, so a later copy without it removes it.
  target.profiles.apply(MEMBER, { files: [text('CLAUDE.md', 'rules')], skipped: [] })
  expect(existsSync(join(claudeHome, 'skills/big/SKILL.md'))).toBe(false)
})

test('an oversized, duplicated, or self-contradicting bundle is refused before anything changes', () => {
  // WHY: the contract limits encoded text, not decoded bytes; the host enforces
  // the advertised size itself, and a bundle that cannot be written whole must
  // not remove the copy already there.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  target.profiles.apply(MEMBER, { files: [text('CLAUDE.md', 'kept')], skipped: [] })
  const oversized = { provider: 'claude-code' as const, path: 'skills/big/SKILL.md', contentBase64: Buffer.alloc(AGENT_PROFILE_MAX_FILE_BYTES + 1).toString('base64') }
  const refused: [AgentProfileBundle, string][] = [
    [{ files: [oversized], skipped: [] }, 'larger than an agent profile file'],
    [{ files: [text('agents/a.md', 'one'), text('agents/a.md', 'two')], skipped: [] }, 'in the profile twice'],
    [{ files: [text('skills/a/SKILL.md', 'file'), text('skills/a/SKILL.md/x', 'nested')], skipped: [] }, 'both a file and a folder'],
  ]
  for (const [bundle, message] of refused) {
    expect(() => target.profiles.apply(MEMBER, bundle)).toThrow(message)
    expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe('kept')
    expect(existsSync(join(claudeHome, 'agents'))).toBe(false)
    expect(existsSync(join(claudeHome, 'skills'))).toBe(false)
  }
})

test('a link in the seat is never written or removed through', () => {
  // WHY: the seat home is the member's; a link placed there must not let the
  // copy change a file outside it, such as the host's own home.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  const outside = temporaryDirectory()
  put(outside, 'review/SKILL.md', 'host skill')
  put(outside, 'CLAUDE.md', 'host rules')
  mkdirSync(join(claudeHome, 'skills'))
  symlinkSync(join(outside, 'review'), join(claudeHome, 'skills/review'))
  symlinkSync(join(outside, 'CLAUDE.md'), join(claudeHome, 'CLAUDE.md'))
  expect(() => target.profiles.apply(MEMBER, { files: [text('skills/review/SKILL.md', 'overwritten')], skipped: [] })).toThrow('is a link')
  expect(() => target.profiles.apply(MEMBER, { files: [text('CLAUDE.md', 'overwritten')], skipped: [] })).toThrow('is a link')
  expect(readFileSync(join(outside, 'review/SKILL.md'), 'utf8')).toBe('host skill')
  expect(readFileSync(join(outside, 'CLAUDE.md'), 'utf8')).toBe('host rules')
})

test('a copy updates the executable bit of a file already in the seat', () => {
  // WHY: a script made executable on the laptop must run on the host too.
  const target = seat()
  const script = join(target.homeFor('claude-code'), 'skills/tool/run.sh')
  target.profiles.apply(MEMBER, { files: [text('skills/tool/run.sh', '#!/bin/sh')], skipped: [] })
  expect(statSync(script).mode & 0o100).toBe(0)
  target.profiles.apply(MEMBER, { files: [{ ...text('skills/tool/run.sh', '#!/bin/sh'), executable: true }], skipped: [] })
  expect(statSync(script).mode & 0o100).toBeTruthy()
})

test('on a host the person owns, a copy never replaces or removes the host\'s own files', () => {
  // WHY: a personal VM's ~/.claude is the owner's own; the copy adds what the
  // laptop has and keeps what the VM had. Aimed at the machine it came from, a
  // copy changes nothing at all.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  mkdirSync(join(claudeHome, 'skills/vm-only'), { recursive: true })
  writeFileSync(join(claudeHome, 'CLAUDE.md'), 'VM rules')
  writeFileSync(join(claudeHome, 'skills/vm-only/SKILL.md'), 'VM skill')
  mkdirSync(join(target.root, 'store/linked'), { recursive: true })
  symlinkSync(join(target.root, 'store/linked'), join(claudeHome, 'skills/linked'))

  const status = target.profiles.apply(OWNER, {
    files: [text('CLAUDE.md', 'laptop rules'), text('skills/laptop/SKILL.md', 'laptop skill'), text('skills/linked/SKILL.md', 'through a link')],
    skipped: [],
  })
  expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe('VM rules')
  expect(readFileSync(join(claudeHome, 'skills/laptop/SKILL.md'), 'utf8')).toBe('laptop skill')
  expect(existsSync(join(target.root, 'store/linked/SKILL.md'))).toBe(false)
  expect(status.fileCount).toBe(1)
  expect(status.skipped.map((skip) => `${skip.path}:${skip.reason}`).sort()).toEqual(['CLAUDE.md:kept-on-host', 'skills/linked/SKILL.md:kept-on-host'])

  // What the copy put there is its own to update and remove; the VM's stay.
  target.profiles.apply(OWNER, { files: [text('skills/laptop/SKILL.md', 'v2')], skipped: [] })
  expect(readFileSync(join(claudeHome, 'skills/laptop/SKILL.md'), 'utf8')).toBe('v2')
  target.profiles.remove(OWNER)
  expect(existsSync(join(claudeHome, 'skills/laptop'))).toBe(false)
  expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe('VM rules')
  expect(readFileSync(join(claudeHome, 'skills/vm-only/SKILL.md'), 'utf8')).toBe('VM skill')
})
