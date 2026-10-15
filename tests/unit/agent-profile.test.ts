import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SeatProvider } from '@solus/contracts/seats'
import {
  AGENT_PROFILE_MAX_FILE_BYTES,
  agentProfileSchema,
  agentProfileKeyOf,
  isAgentProfilePath,
  type AgentProfile,
  type AgentProfileEntry,
  type AgentProfileCopy,
  type AgentProfileFileEntry,
  type AgentProfileIntegrationEntry,
  type AgentProfileSkip,
} from '@solus/contracts/agent-profile'
import type { Integration } from '@solus/contracts/integration-types'
import { AGENT_PROFILE_READ_PATH, AgentProfileManager, AgentProfileRefused, type ProfileAccount, type ProfileIntegrationOwner, type ProfileIntegrations, type ProfileSkills } from '@solus/server/execution/seats/agent-profile'
import { AccountReads } from '@solus/server/vault/account-reads'

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
  // The home's own instructions file is not part of the profile.
  put(claude, 'CLAUDE.md', 'Be brief.')
  put(claude, 'agents/reviewer.md', 'Review carefully.')
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
  // A registry install: carried as a reference, never as files.
  put(claude, 'skills/frontend-design/SKILL.md', 'From the registry')
  put(codex, 'AGENTS.md', 'Codex rules')
  put(codex, 'skills/review/SKILL.md', 'Codex review skill')
  put(codex, 'skills/.system/builtin/SKILL.md')
  put(codex, 'auth.json', 'token')
  const homes = (provider: SeatProvider) => provider === 'claude-code' ? [claude] : [codex, agents]
  return { homes }
}

const MEMBER = { kind: 'member', userId: 'member-1', organizationId: 'org-a' } as const
const OWNER = { kind: 'owner' } as const

/** The skills CLI as a map of installed skills per home set. */
function fakeSkills() {
  const installed = new Map<string, Map<string, string>>()
  const log: string[] = []
  const bucket = (homes?: { claudeHome: string }) => {
    const key = homes?.claudeHome ?? 'host'
    if (!installed.has(key)) installed.set(key, new Map())
    return installed.get(key)!
  }
  const skills: ProfileSkills = {
    list: async (homes) => ({ ok: true, skills: [...bucket(homes)].map(([name, source]) => ({ name, path: `/${name}`, agents: ['claude-code'], source })) }),
    install: async (id, agents, homes) => {
      log.push(`install:${id}`)
      if (id.endsWith('@broken')) return { ok: false, agents, error: 'nope' }
      const [source, name] = id.split('@')
      bucket(homes).set(name, source)
      return { ok: true, agents }
    },
    remove: async (name, homes) => { log.push(`remove:${name}`); bucket(homes).delete(name); return { ok: true } },
  }
  return { skills, log, bucket }
}


/** The host's owner as a person: their MCP records and connections are under this key, as a member's are under theirs. */
const HOST_USER = 'local:owner'

interface HostRecord { url: string; slug: string; ownerKey: string }
/** The integration records as rows in memory. */
/** `hostHas`: records the host already has, each of its owner (docs/plans/access-model.md, D3). */
function fakeIntegrations(hostHas: HostRecord[] = []) {
  const rows: Integration[] = []
  let next = 1
  const record = (owner: { organizationId: string; ownerKey: string }, slug: string, name: string, url: string): Integration => ({
    id: `int-${next++}`, organizationId: owner.organizationId, ownerKey: owner.ownerKey, kind: 'mcp', slug, name, url, auth: { kind: 'none' }, disabledTools: [], createdBy: owner.ownerKey, createdAt: '', updatedAt: '',
  })
  for (const had of hostHas) rows.push(record({ organizationId: 'local', ownerKey: had.ownerKey }, had.slug, had.slug, had.url))
  const log: string[] = []
  const integrations: ProfileIntegrations = {
    list: (owner) => rows.filter((row) => row.ownerKey === owner.ownerKey && row.organizationId === owner.organizationId),
    findByUrl: (owner, url) => rows.find((row) => row.url === url && row.ownerKey === owner.ownerKey && row.organizationId === owner.organizationId) ?? null,
    create: (owner, entry) => { const created = record(owner, entry.slug, entry.name, entry.url); rows.push(created); log.push(`create:${entry.slug}`); return created },
    update: (id, entry) => { const row = rows.find((each) => each.id === id)!; row.name = entry.name; log.push(`update:${entry.slug}`) },
    remove: (id) => { const index = rows.findIndex((each) => each.id === id); log.push(`remove:${rows[index]?.slug}`); rows.splice(index, 1) },
  }
  return { integrations, rows, log }
}

/** A host with one member's seat homes, reading its own profile from `sourceHomes`. */
function seat(sourceHomes: (provider: SeatProvider) => string[] = () => [], hostIntegrations: HostRecord[] = [], account?: ProfileAccount) {
  const root = temporaryDirectory()
  const homeFor = (provider: SeatProvider) => {
    const home = join(root, provider === 'claude-code' ? 'claude' : 'codex')
    mkdirSync(home, { recursive: true })
    return home
  }
  let now = 1000
  const skills = fakeSkills()
  const integrations = fakeIntegrations(hostIntegrations)
  const profiles = new AgentProfileManager({
    sourceHomes,
    homeFor: (target, provider) => {
      expect([MEMBER, OWNER]).toContainEqual(target)
      return homeFor(provider)
    },
    now: () => now,
    skills: skills.skills,
    skillHomesFor: (target) => target.kind === 'member' ? { claudeHome: homeFor('claude-code'), codexHome: homeFor('codex') } : undefined,
    agentIds: () => ['claude-code', 'codex'],
    integrations: integrations.integrations,
    integrationOwnerFor: (target) => target.kind === 'member' ? { organizationId: target.organizationId, ownerKey: target.userId } : { organizationId: 'local', ownerKey: HOST_USER },
    account,
  })
  return { root, homeFor, profiles, skills, integrations, at: (time: number) => { now = time } }
}

function text(path: string, content: string, provider: SeatProvider = 'claude-code'): AgentProfileFileEntry {
  return { kind: 'file', provider, path, contentBase64: Buffer.from(content).toString('base64'), hash: 'a'.repeat(64) }
}

function profile(...entries: AgentProfileEntry[]): AgentProfileCopy {
  return { profile: Object.fromEntries(entries.map((entry) => [agentProfileKeyOf(entry), entry])), skipped: [] }
}

const PUSH = { kind: 'computer' } as const

test('a profile carries instructions, skills, subagents, commands, and MCP servers, never logins, settings, or transcripts', async () => {
  // WHY: the copy leaves the person's machine; only what shapes how an agent
  // works may go, and a credential must never ride along. A registry skill
  // travels as a reference, so the document stays small and the host installs it.
  const { homes } = laptop()
  const host = seat(homes)
  host.skills.bucket().set('frontend-design', 'anthropics/skills')
  host.integrations.integrations.create({ organizationId: 'local', ownerKey: HOST_USER }, { kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } })
  const read = await host.profiles.read()
  expect(Object.keys(read.profile).sort()).toEqual([
    'file:claude-code/agents/reviewer.md',
    'file:claude-code/commands/ship.md',
    'file:claude-code/skills/review/SKILL.md',
    'file:claude-code/skills/review/scripts/run.sh',
    'file:codex/skills/review/SKILL.md',
    'file:codex/skills/review/scripts/run.sh',
    'integration:deepwiki',
    'skill:frontend-design',
  ])
  expect(read.profile['skill:frontend-design']).toEqual({ kind: 'skill', name: 'frontend-design', source: 'anthropics/skills', skillId: 'frontend-design' })
  // Codex's own skill wins over the shared one of the same name.
  const codexSkill = read.profile['file:codex/skills/review/SKILL.md']
  expect(codexSkill?.kind === 'file' && Buffer.from(codexSkill.contentBase64, 'base64').toString()).toBe('Codex review skill')
  expect(read.skipped).toEqual([{ provider: 'claude-code', path: 'skills/huge/SKILL.md', reason: 'file-too-large' }])
  expect(agentProfileSchema.safeParse(read.profile).success).toBe(true)
})

test('copying again replaces the profile and leaves everything else in the seat alone', async () => {
  // WHY: the laptop is the source, so a skill deleted there must go on the host
  // too; the member's login in the same folder must survive every copy.
  const { homes } = laptop()
  const target = seat(homes)
  put(target.homeFor('claude-code'), '.credentials.json', 'member login')
  const read = await target.profiles.read()
  const first = await target.profiles.apply(MEMBER, read, PUSH)
  expect(first).toMatchObject({ syncedAt: 1000, source: 'computer', revision: null, counts: { files: 7, skills: 0, integrations: 0 } })
  const claudeHome = target.homeFor('claude-code')
  expect(readFileSync(join(claudeHome, 'agents/reviewer.md'), 'utf8')).toBe('Review carefully.')
  expect(existsSync(join(claudeHome, 'CLAUDE.md'))).toBe(false)
  expect(statSync(join(claudeHome, 'skills/review/scripts/run.sh')).mode & 0o100).toBeTruthy()

  const withoutReview: AgentProfileCopy = { profile: Object.fromEntries(Object.entries(read.profile).filter(([key]) => !key.includes('skills/review'))), skipped: read.skipped }
  target.at(2000)
  await target.profiles.apply(MEMBER, withoutReview, PUSH)
  expect(existsSync(join(claudeHome, 'skills/review'))).toBe(false)
  expect(existsSync(join(claudeHome, 'skills'))).toBe(true)
  expect(readFileSync(join(claudeHome, '.credentials.json'), 'utf8')).toBe('member login')

  const removed = await target.profiles.remove(MEMBER)
  expect(removed).toEqual({ syncedAt: null, source: null, revision: null, counts: { files: 0, skills: 0, integrations: 0 }, skipped: [] })
  expect(existsSync(join(claudeHome, 'agents/reviewer.md'))).toBe(false)
  expect(target.profiles.status(MEMBER).syncedAt).toBeNull()
  expect(readFileSync(join(claudeHome, '.credentials.json'), 'utf8')).toBe('member login')
})

test('a registry skill is installed into the target\'s homes, removed when it leaves the profile, and a failed install is reported', async () => {
  // WHY: the host keeps one installer; a reference must become real files in the
  // member's seats and nowhere else, and one bad skill must not stop the copy.
  const target = seat()
  const skill = (name: string, source = 'anthropics/skills'): AgentProfileEntry => ({ kind: 'skill', name, source, skillId: name })
  const status = await target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'rules'), skill('frontend-design'), skill('broken', 'acme')), PUSH)
  expect(target.skills.log).toEqual(['install:anthropics/skills@frontend-design', 'install:acme@broken'])
  expect(status.counts).toEqual({ files: 1, skills: 1, integrations: 0 })
  expect(status.skipped).toEqual([{ path: 'broken', reason: 'install-failed' }])
  expect(target.skills.bucket({ claudeHome: target.homeFor('claude-code') }).get('frontend-design')).toBe('anthropics/skills')
  expect(target.skills.bucket().size).toBe(0)

  // Installed already from the same source: no second install. Gone from the profile: removed.
  target.skills.log.length = 0
  await target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'rules'), skill('frontend-design')), PUSH)
  expect(target.skills.log).toEqual([])
  await target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'rules')), PUSH)
  expect(target.skills.log).toEqual(['remove:frontend-design'])
})

test('an MCP server becomes the member\'s own record, matched by URL, and a host the person owns keeps its own', async () => {
  // WHY: each host mints its own ids, so a record is found by its URL. Every record
  // is one person's (D3): a copy never reaches another person's record.
  const server = (slug: string, url = `https://${slug}.example/mcp`): AgentProfileIntegrationEntry => ({ kind: 'integration', slug, name: slug.toUpperCase(), url, auth: { kind: 'none' } })
  const member = seat(() => [], [{ slug: 'shared', url: 'https://shared.example/mcp', ownerKey: HOST_USER }])
  const first = await member.profiles.apply(MEMBER, profile(server('linear'), server('shared')), PUSH)
  expect(member.integrations.log).toEqual(['create:linear', 'create:shared'])
  expect(first.counts.integrations).toBe(2)
  expect(first.skipped).toEqual([])
  const own = member.integrations.rows.find((row) => row.slug === 'linear')!
  expect(own).toMatchObject({ ownerKey: 'member-1', organizationId: 'org-a' })

  member.integrations.log.length = 0
  await member.profiles.apply(MEMBER, profile({ ...server('linear'), name: 'Linear issues' }, server('context7')), PUSH)
  expect(member.integrations.log).toEqual(['update:linear', 'create:context7', 'remove:shared'])
  await member.profiles.remove(MEMBER)
  expect(member.integrations.log.slice(3).sort()).toEqual(['remove:context7', 'remove:linear'])
  expect(member.integrations.rows.map((row) => row.slug)).toEqual(['shared'])

  // A server the host user already had on their own host, made another way, is kept as it is by a computer's push.
  const owned = seat(() => [], [{ slug: 'shared', url: 'https://shared.example/mcp', ownerKey: HOST_USER }])
  const status = await owned.profiles.apply(OWNER, profile(server('linear'), server('shared')), PUSH)
  expect(owned.integrations.log).toEqual(['create:linear'])
  expect(owned.integrations.rows.find((row) => row.slug === 'linear')?.ownerKey).toBe(HOST_USER)
  expect(status.skipped).toEqual([{ path: 'shared', reason: 'kept-on-host' }])
})

test('a pulled profile records its account revision, so a pull with the same revision does nothing', async () => {
  const target = seat()
  const status = await target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'rules')), { kind: 'account', revision: 7 })
  expect(status).toMatchObject({ source: 'account', revision: 7 })
  expect(target.profiles.status(MEMBER)).toMatchObject({ source: 'account', revision: 7 })
})

test('a path outside the profile is refused before anything is written', async () => {
  // WHY: the document comes over the network; it must not reach a login file or
  // climb out of the seat.
  const target = seat()
  for (const path of ['.credentials.json', '../escape.md', 'skills/../../x', 'settings.json', '/etc/passwd', 'skills', 'CLAUDE.md', 'agents']) {
    expect(isAgentProfilePath('claude-code', path)).toBe(false)
  }
  await expect(target.profiles.apply(MEMBER, profile(text('agents/ok.md', 'ok'), text('.credentials.json', 'stolen')), PUSH)).rejects.toThrow('is not part of an agent profile')
  expect(existsSync(join(target.homeFor('claude-code'), 'agents/ok.md'))).toBe(false)
})

test('a home\'s CLAUDE.md or AGENTS.md from an older copy is left out, and the rest of the profile applies', async () => {
  // WHY: instruction files left the profile. A copy kept from before must not make every host refuse the person's whole profile.
  const target = seat()
  const status = await target.profiles.apply(MEMBER, profile(text('agents/ok.md', 'ok'), text('CLAUDE.md', 'old instructions')), PUSH)
  expect(status.counts.files).toBe(1)
  expect(existsSync(join(target.homeFor('claude-code'), 'agents/ok.md'))).toBe(true)
  expect(existsSync(join(target.homeFor('claude-code'), 'CLAUDE.md'))).toBe(false)
})

test('a registry skill and a hand-written skill of one name are refused before anything is written', async () => {
  // WHY: the two appliers would fight over one folder.
  const target = seat()
  const both = profile(text('skills/review/SKILL.md', 'mine'), { kind: 'skill', name: 'review', source: 'acme/skills', skillId: 'review' })
  await expect(target.profiles.apply(MEMBER, both, PUSH)).rejects.toThrow('both a registry skill and a hand-written skill')
  expect(existsSync(join(target.homeFor('claude-code'), 'skills'))).toBe(false)
})

test('a file the laptop could not send keeps the copy already in the seat', async () => {
  // WHY: an unreadable or oversized source file is not a deletion; only a file
  // the laptop no longer has may go from the seat.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  await target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'rules'), text('skills/big/SKILL.md', 'v1'), text('agents/old.md', 'old')), PUSH)
  const status = await target.profiles.apply(MEMBER, { ...profile(text('agents/rules.md', 'rules')), skipped: [{ provider: 'claude-code', path: 'skills/big/SKILL.md', reason: 'file-too-large' }] }, PUSH)
  expect(readFileSync(join(claudeHome, 'skills/big/SKILL.md'), 'utf8')).toBe('v1')
  expect(existsSync(join(claudeHome, 'agents/old.md'))).toBe(false)
  expect(status.skipped).toEqual([{ provider: 'claude-code', path: 'skills/big/SKILL.md', reason: 'file-too-large' }])
  // The kept copy is still the profile's, so a later copy without it removes it.
  await target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'rules')), PUSH)
  expect(existsSync(join(claudeHome, 'skills/big/SKILL.md'))).toBe(false)
})

test('an oversized, duplicated, or self-contradicting document is refused before anything changes', async () => {
  // WHY: the contract limits encoded text, not decoded bytes; the host enforces
  // the advertised size itself, and a document that cannot be written whole must
  // not remove the copy already there.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  await target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'kept')), PUSH)
  const oversized: AgentProfileEntry = { kind: 'file', provider: 'claude-code', path: 'skills/big/SKILL.md', contentBase64: Buffer.alloc(AGENT_PROFILE_MAX_FILE_BYTES + 1).toString('base64'), hash: 'a'.repeat(64) }
  const refused: [AgentProfileCopy, string][] = [
    [profile(oversized), 'larger than an agent profile file'],
    [profile(text('skills/a/SKILL.md', 'file'), text('skills/a/SKILL.md/x', 'nested')), 'both a file and a folder'],
  ]
  for (const [bad, message] of refused) {
    await expect(target.profiles.apply(MEMBER, bad, PUSH)).rejects.toThrow(message)
    expect(readFileSync(join(claudeHome, 'agents/rules.md'), 'utf8')).toBe('kept')
    expect(existsSync(join(claudeHome, 'skills'))).toBe(false)
  }
})

test('a link in the seat is never written or removed through', async () => {
  // WHY: the seat home is the member's; a link placed there must not let the
  // copy change a file outside it, such as the host's own home.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  const outside = temporaryDirectory()
  put(outside, 'review/SKILL.md', 'host skill')
  put(outside, 'rules.md', 'host rules')
  mkdirSync(join(claudeHome, 'skills'))
  mkdirSync(join(claudeHome, 'agents'))
  symlinkSync(join(outside, 'review'), join(claudeHome, 'skills/review'))
  symlinkSync(join(outside, 'rules.md'), join(claudeHome, 'agents/rules.md'))
  await expect(target.profiles.apply(MEMBER, profile(text('skills/review/SKILL.md', 'overwritten')), PUSH)).rejects.toThrow('is a link')
  await expect(target.profiles.apply(MEMBER, profile(text('agents/rules.md', 'overwritten')), PUSH)).rejects.toThrow('is a link')
  expect(readFileSync(join(outside, 'review/SKILL.md'), 'utf8')).toBe('host skill')
  expect(readFileSync(join(outside, 'rules.md'), 'utf8')).toBe('host rules')
})

test('a copy updates the executable bit of a file already in the seat', async () => {
  // WHY: a script made executable on the laptop must run on the host too.
  const target = seat()
  const script = join(target.homeFor('claude-code'), 'skills/tool/run.sh')
  await target.profiles.apply(MEMBER, profile(text('skills/tool/run.sh', '#!/bin/sh')), PUSH)
  expect(statSync(script).mode & 0o100).toBe(0)
  await target.profiles.apply(MEMBER, profile({ ...text('skills/tool/run.sh', '#!/bin/sh'), executable: true }), PUSH)
  expect(statSync(script).mode & 0o100).toBeTruthy()
})

test('on a host the person owns, a copy never replaces or removes the host\'s own files', async () => {
  // WHY: a personal VM's ~/.claude is the owner's own; the copy adds what the
  // laptop has and keeps what the VM had. Aimed at the machine it came from, a
  // copy changes nothing at all.
  const target = seat()
  const claudeHome = target.homeFor('claude-code')
  mkdirSync(join(claudeHome, 'skills/vm-only'), { recursive: true })
  mkdirSync(join(claudeHome, 'agents'))
  writeFileSync(join(claudeHome, 'agents/rules.md'), 'VM rules')
  writeFileSync(join(claudeHome, 'skills/vm-only/SKILL.md'), 'VM skill')
  mkdirSync(join(target.root, 'store/linked'), { recursive: true })
  symlinkSync(join(target.root, 'store/linked'), join(claudeHome, 'skills/linked'))

  const status = await target.profiles.apply(OWNER, profile(text('agents/rules.md', 'laptop rules'), text('skills/laptop/SKILL.md', 'laptop skill'), text('skills/linked/SKILL.md', 'through a link')), PUSH)
  expect(readFileSync(join(claudeHome, 'agents/rules.md'), 'utf8')).toBe('VM rules')
  expect(readFileSync(join(claudeHome, 'skills/laptop/SKILL.md'), 'utf8')).toBe('laptop skill')
  expect(existsSync(join(target.root, 'store/linked/SKILL.md'))).toBe(false)
  expect(status.counts.files).toBe(1)
  expect(status.skipped.map((skip) => `${skip.path}:${skip.reason}`).sort()).toEqual(['agents/rules.md:kept-on-host', 'skills/linked/SKILL.md:kept-on-host'])

  // What the copy put there is its own to update and remove; the VM's stay.
  await target.profiles.apply(OWNER, profile(text('skills/laptop/SKILL.md', 'v2')), PUSH)
  expect(readFileSync(join(claudeHome, 'skills/laptop/SKILL.md'), 'utf8')).toBe('v2')
  await target.profiles.remove(OWNER)
  expect(existsSync(join(claudeHome, 'skills/laptop'))).toBe(false)
  expect(readFileSync(join(claudeHome, 'agents/rules.md'), 'utf8')).toBe('VM rules')
  expect(readFileSync(join(claudeHome, 'skills/vm-only/SKILL.md'), 'utf8')).toBe('VM skill')
})

// ─── The pull (plans/020 §4): the person's account is the source ───

/**
 * A host linked to a fake account plane that answers one profile and connection list.
 * It reads as the person with its delegation for them (ADR 0001 §3.4); `delegated:
 * false` is a person this host does not act for.
 */
function linked(options: { answer?: (request: Request) => Promise<Response>; delegated?: boolean; linked?: boolean; hostHas?: HostRecord[] } = {}) {
  const requests: Request[] = []
  const reconciled: Array<{ owner: ProfileIntegrationOwner; connections: string[] }> = []
  const reads = new AccountReads({
    origin: () => (options.linked ?? true) ? 'https://cloud.test' : null,
    delegations: () => ({
      holders: () => options.delegated === false ? [] : [{ userId: 'member-1', scope: { organizationId: 'org-a' } }, { userId: 'owner-1', scope: 'personal' }],
      accessToken: async (userId) => `delegated-${userId}`,
    }),
    fetchImpl: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return options.answer ? options.answer(request) : Response.json({ profile: null, connections: [] })
    },
  })
  const target = seat(() => [], options.hostHas ?? [], {
    reads,
    userFor: (profileTarget) => profileTarget.kind === 'member' ? profileTarget.userId : 'owner-1',
    reconcile: async (owner, connections) => { reconciled.push({ owner, connections: connections.flatMap((connection) => connection.ref.kind === 'mcp' ? [connection.ref.serverUrl] : []) }) },
  })
  return { ...target, requests, reconciled }
}

const accountProfile = (revision: number, connections: string[] = []) => Response.json({
  profile: { schemaVersion: 1, generation: 0, revision, entries: { 'file:claude-code/agents/rules.md': text('agents/rules.md', `rules v${revision}`) }, updatedAt: 5 },
  connections: connections.map((serverUrl) => ({ ref: { kind: 'mcp', serverUrl }, material: 'key', status: 'connected', label: null, updatedAt: 1 })),
})

test('a pull reads with the person\'s delegated token as the bearer and no body, applies a moved revision as an account copy, and reconciles the connections', async () => {
  // WHY: ADR 0001 §2.2 rule 7 — no token in a body, no host token beside it.
  const host = linked({ answer: async () => accountProfile(3, ['https://linear.example/mcp']) })
  const status = await host.profiles.pull(MEMBER)
  expect(host.requests[0].url).toBe(`https://cloud.test${AGENT_PROFILE_READ_PATH}`)
  expect(host.requests[0].headers.get('authorization')).toBe('Bearer delegated-member-1')
  expect(await host.requests[0].text()).toBe('')
  expect(status).toMatchObject({ source: 'account', revision: 3, counts: { files: 1 } })
  expect(readFileSync(join(host.homeFor('claude-code'), 'agents/rules.md'), 'utf8')).toBe('rules v3')
  expect(host.reconciled).toEqual([{ owner: { organizationId: 'org-a', ownerKey: 'member-1' }, connections: ['https://linear.example/mcp'] }])
})

test('a revision the host already applied is not applied again, and a person with no synced profile keeps the pushed copy', async () => {
  // WHY: the periodic pull runs for every seat every few minutes; it must cost
  // one read when nothing changed, and must not erase a push from the computer.
  let revision = 3
  const host = linked({ answer: async () => accountProfile(revision) })
  await host.profiles.pull(MEMBER)
  host.at(2000)
  expect((await host.profiles.pull(MEMBER)).syncedAt).toBe(1000)
  revision = 4
  expect((await host.profiles.pull(MEMBER)).revision).toBe(4)

  const pushed = linked({ answer: async () => Response.json({ profile: null, connections: [] }) })
  await pushed.profiles.apply(MEMBER, profile(text('agents/rules.md', 'from the laptop')), PUSH)
  expect((await pushed.profiles.pull(MEMBER)).source).toBe('computer')
})

test('a person with no synced profile still has their account connections reconciled', async () => {
  // WHY: a signed-in person signs in at the cloud whether or not their profile syncs; the pull is how a host learns of it.
  const host = linked({ answer: async () => Response.json({ profile: null, connections: [{ ref: { kind: 'mcp', serverUrl: 'https://linear.example/mcp' }, material: 'oauth', status: 'connected', label: null, updatedAt: 1 }] }) })
  await host.profiles.pull(MEMBER)
  expect(host.reconciled).toEqual([{ owner: { organizationId: 'org-a', ownerKey: 'member-1' }, connections: ['https://linear.example/mcp'] }])
})

test('an unlinked host, a person without a token, an unreachable cloud, and a refusal each name their reason, and a quiet pull never throws', async () => {
  await expect(linked({ linked: false }).profiles.pull(MEMBER)).rejects.toMatchObject({ code: 'NOT_LINKED' })
  await expect(linked({ delegated: false }).profiles.pull(MEMBER)).rejects.toMatchObject({ code: 'NO_TOKEN' })
  await expect(linked({ answer: async () => { throw new Error('ECONNREFUSED') } }).profiles.pull(MEMBER)).rejects.toMatchObject({ code: 'UNREACHABLE' })
  await expect(linked({ answer: async () => Response.json({ error: 'unauthorized' }, { status: 401 }) }).profiles.pull(MEMBER)).rejects.toBeInstanceOf(AgentProfileRefused)
  await linked({ linked: false }).profiles.pullQuietly(MEMBER)
})

test('the periodic sweep pulls for every target now and again on the interval', async () => {
  const host = linked({ answer: async () => accountProfile(1) })
  const stop = host.profiles.startPeriodic(() => [MEMBER, OWNER], 60_000)
  await new Promise((done) => setTimeout(done, 0))
  expect(host.requests).toHaveLength(2)
  stop()
})

// ─── Signed in, the account is the one list (plans/020 §10, 2026-10-12) ───

/** An account plane that keeps one person's profile and answers the read and the host's merge. */
function cloudOf(initial: AgentProfile | null) {
  let entries: AgentProfile | null = initial
  let revision = initial ? 1 : 0
  const writes: Array<{ set: string[]; reset: string[] }> = []
  let isDown = false
  const answer = async (request: Request): Promise<Response> => {
    if (isDown) throw new Error('ECONNREFUSED')
    if (request.url.endsWith('/v1/agent-profile/entries')) {
      const body = await request.json() as { set: AgentProfile; reset: string[] }
      writes.push({ set: Object.keys(body.set), reset: body.reset })
      entries = { ...(entries ?? {}), ...body.set }
      for (const key of body.reset) delete entries[key as keyof AgentProfile]
      revision += 1
      return Response.json({ schemaVersion: 1, generation: 0, revision, entries, updatedAt: 1 })
    }
    return Response.json({ profile: entries ? { schemaVersion: 1, generation: 0, revision, entries, updatedAt: 1 } : null, connections: [] })
  }
  return { answer, writes, entries: () => entries, down: (value: boolean) => { isDown = value } }
}

const PLANETSCALE_URL = 'https://mcp.pscale.dev/mcp/planetscale'
const serverEntry = (slug: string, url: string): AgentProfileIntegrationEntry => ({ kind: 'integration', slug, name: slug, url, auth: { kind: 'none' } })

test('a pull adopts the owner\'s own MCP servers the profile does not name, and creates the profile when there is none', async () => {
  // WHY: signed in, a server added on a host before sync, such as PlanetScale, must become part of the person's profile.
  const cloud = cloudOf(null)
  const host = linked({ answer: cloud.answer, hostHas: [{ slug: 'planetscale', url: PLANETSCALE_URL, ownerKey: HOST_USER }] })
  const status = await host.profiles.pull(OWNER)
  expect(cloud.writes).toEqual([{ set: ['integration:planetscale'], reset: [] }])
  expect(cloud.entries()).toMatchObject({ 'integration:planetscale': { url: PLANETSCALE_URL } })
  // The record is the profile's now: a later removal in the profile removes it here too.
  expect(status).toMatchObject({ source: 'account', counts: { integrations: 1 } })
  expect(host.integrations.rows.map((row) => row.slug)).toEqual(['planetscale'])
  await host.profiles.pull(OWNER)
  expect(cloud.writes).toHaveLength(1)
})

test('a pull removes a retired AGENTS.md from the account and applies the rest', async () => {
  // WHY: the account is the one list. An entry no host applies must leave it, or every client lists it again.
  const agents = text('AGENTS.md', 'old', 'codex')
  const rules = text('agents/rules.md', 'rules')
  const cloud = cloudOf({ [agentProfileKeyOf(agents)]: agents, [agentProfileKeyOf(rules)]: rules })
  const host = linked({ answer: cloud.answer })
  const status = await host.profiles.pull(MEMBER)
  expect(cloud.writes).toEqual([{ set: [], reset: ['file:codex/AGENTS.md'] }])
  expect(Object.keys(cloud.entries() ?? {})).toEqual(['file:claude-code/agents/rules.md'])
  expect(status).toMatchObject({ source: 'account', counts: { files: 1 } })
  await host.profiles.pull(MEMBER)
  expect(cloud.writes).toHaveLength(1)
})

test('removing a server from the profile takes it off the host on the next pull, and it is not adopted back', async () => {
  const cloud = cloudOf(null)
  const host = linked({ answer: cloud.answer, hostHas: [{ slug: 'planetscale', url: PLANETSCALE_URL, ownerKey: HOST_USER }, { slug: 'linear', url: 'https://mcp.linear.app/mcp', ownerKey: HOST_USER }] })
  await host.profiles.pull(OWNER)
  expect(host.integrations.rows.map((row) => row.slug).sort()).toEqual(['linear', 'planetscale'])

  // Elsewhere, the person removes both.
  const entries = cloud.entries()!
  delete entries['integration:planetscale']
  delete entries['integration:linear']
  await cloud.answer(new Request('https://cloud.test/v1/agent-profile/entries', { method: 'POST', body: JSON.stringify({ set: {}, reset: [] }) }))
  cloud.writes.length = 0

  await host.profiles.pull(OWNER)
  expect(host.integrations.rows).toEqual([])
  // WHY: a record the profile removed is gone from the host, so there is nothing left to adopt back.
  expect(cloud.writes).toEqual([])

  // Added again elsewhere, it comes back.
  cloud.entries()!['integration:planetscale'] = serverEntry('planetscale', PLANETSCALE_URL)
  await cloud.answer(new Request('https://cloud.test/v1/agent-profile/entries', { method: 'POST', body: JSON.stringify({ set: {}, reset: [] }) }))
  await host.profiles.pull(OWNER)
  expect(host.integrations.rows.map((row) => row.slug)).toEqual(['planetscale'])
})

test('a server saved or removed in Settings → MCP writes through to the profile; another person\'s server does not', async () => {
  const cloud = cloudOf({})
  const host = linked({ answer: cloud.answer })
  const own: Integration = { id: 'int-own', organizationId: 'local', ownerKey: HOST_USER, kind: 'mcp', slug: 'planetscale', name: 'PlanetScale', url: PLANETSCALE_URL, auth: { kind: 'none' }, createdBy: null, createdAt: '', updatedAt: '' }
  await host.profiles.integrationSaved(OWNER, own)
  expect(cloud.writes[0]).toEqual({ set: ['integration:planetscale'], reset: [] })

  await host.profiles.integrationRemoving(OWNER, own)
  expect(cloud.writes.at(-1)).toEqual({ set: [], reset: ['integration:planetscale'] })

  // A record of another person is not this person's profile's.
  const writes = cloud.writes.length
  await host.profiles.integrationSaved(MEMBER, { ...own, organizationId: 'org-a', ownerKey: 'someone-else' })
  expect(cloud.writes).toHaveLength(writes)
})

test('a removal is refused while the cloud is unreachable, so the next pull cannot bring the server back; not signed in, it is the host\'s alone', async () => {
  const cloud = cloudOf({})
  const host = linked({ answer: cloud.answer })
  const own: Integration = { id: 'int-own', organizationId: 'local', ownerKey: HOST_USER, kind: 'mcp', slug: 'planetscale', name: 'PlanetScale', url: PLANETSCALE_URL, auth: { kind: 'none' }, createdBy: null, createdAt: '', updatedAt: '' }
  cloud.down(true)
  await expect(host.profiles.integrationRemoving(OWNER, own)).rejects.toMatchObject({ code: 'UNREACHABLE' })
  await linked({ linked: false }).profiles.integrationRemoving(OWNER, own)
})
