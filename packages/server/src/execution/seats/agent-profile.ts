import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AGENT_PROFILE_ENTRIES_PATH,
  accountAgentProfileResponseSchema,
  agentProfileFrom,
  agentProfileKeyOf,
  agentProfileSkipSchema,
  agentProfileSourceSchema,
  EMPTY_AGENT_PROFILE_STATUS,
  type AccountAgentProfileResponse,
  type AgentProfile,
  type AgentProfileCopy,
  type AgentProfileEntriesWrite,
  type AgentProfileEntry,
  type AgentProfileFileEntry,
  type AgentProfileIntegrationEntry,
  type AgentProfileKey,
  type AgentProfileSkillEntry,
  type AgentProfileSkip,
  type AgentProfileStatus,
  retiredAgentProfileKeys,
  withoutRetiredEntries,
} from '@solus/contracts/agent-profile'
import type { Integration } from '@solus/contracts/integration-types'
import { vaultConnectionSchema, type VaultConnection } from '@solus/contracts/vault'
import { SEAT_PROVIDERS, type SeatProvider } from '@solus/contracts/seats'
import type { SkillListResult } from '@solus/contracts/skill-types'
import { createLogger } from '../../logger'
import type { RegistrySkillFile } from '../../skills/registry-skill-cache'
import { planProfileFiles, readProfileFiles, resolvedHome, sha256Hex, writeProfileFiles } from './profile-files'
import { applyMemberFiles } from './member-files'
import type { ProcessUser } from '../../cli-env'
import { hostClaudeDir, hostCodexHome } from './seat-login'
import type { AccountReads } from '../../vault/account-reads'


const log = createLogger('seats', 'agent-profile.ts')

/**
 * A person's agent profile on a host (docs/agent-profile.md,
 * plans/020-agent-profile.md). One owner: it reads this machine's profile,
 * applies a profile to a person's seats (or to the homes of a host they own),
 * pulls a profile from the person's account, and answers what a host holds.
 * An apply sequences two appliers — the files, registry skills included as
 * plain files, and the person's MCP servers as personal integrations — and
 * writes one manifest last. Nothing here moves a login, a key, or a token.
 */

/** Written into each seat home, so the next copy removes what it no longer holds. */
const MANIFEST_FILE = '.solus-profile.json'
export const AGENT_PROFILE_READ_PATH = '/v1/agent-profile/read'
/** How often every person with a seat is pulled for, so a change made elsewhere lands without a client's nudge. */
export const AGENT_PROFILE_PULL_INTERVAL_MS = 5 * 60_000

const manifestSchema = z.object({
  version: z.literal(2),
  source: agentProfileSourceSchema,
  revision: z.number().int().nullable(),
  syncedAt: z.number(),
  files: z.array(z.string()),
  /** Registry skills by name, and the ids of the integrations this copy made; the same in every home. */
  skills: z.array(z.string()),
  integrations: z.array(z.string()),
  skipped: z.array(agentProfileSkipSchema),
})
type Manifest = z.infer<typeof manifestSchema>

/** A person's account as a pull reads it: the profile, null when never synced, and the status of each connection in their vault. */
interface AccountRead {
  profile: AccountAgentProfileResponse | null
  connections: VaultConnection[]
}

/** What the account plane answers a host's read: the document, or that the person has none, and their vault's statuses (never the material). */
const accountReadSchema = z.union([
  z.object({ profile: accountAgentProfileResponseSchema.nullable(), connections: z.array(vaultConnectionSchema) }).strict(),
  z.object({ error: z.string() }),
])

/** The homes each provider's profile is read from, first one wins a path. The
 *  shared `~/.agents/skills` is where the skills CLI installs for Codex. */
export function hostProfileHomes(provider: SeatProvider): string[] {
  return provider === 'claude-code' ? [hostClaudeDir()] : [hostCodexHome(), join(homedir(), '.agents')]
}

/**
 * Whose homes a copy goes into: a member's seats on a shared host, or the
 * owner's own homes on a host they own that is not the machine the copy came
 * from, such as their personal VM. A member's `name` names their folder the
 * first time it is made.
 */
export type AgentProfileTarget = { kind: 'member'; userId: string; organizationId: string; name?: string } | { kind: 'owner' }

/** Where a copy came from. A pull names the account revision it applied. */
export type AgentProfileOrigin = { kind: 'computer' } | { kind: 'account'; revision: number }

export class AgentProfileRefused extends Error {
  constructor(readonly code: 'NOT_LINKED' | 'NO_TOKEN' | 'UNREACHABLE' | 'REFUSED', message: string) {
    super(message)
    this.name = 'AgentProfileRefused'
  }
}

/** Registry skills as the profile uses them, injected so a test needs no `npx`. */
export interface ProfileSkills {
  /** This machine's registry skills, which a read carries as references. */
  list(): Promise<SkillListResult>
  /** A registry skill's files, by path inside its folder (`registry-skill-cache.ts`). */
  files(entry: AgentProfileSkillEntry): Promise<RegistrySkillFile[]>
}

/**
 * Whose integration records and connections a target's servers are: always the
 * person's own, by user key (`ownerKeyOf`), the host's owner included.
 * `ownerKey` is also the key the person's connections are under.
 */
export interface ProfileIntegrationOwner {
  organizationId: string
  ownerKey: string
}

/** The integration records as the profile uses them (`integrations/profile-integrations.ts`). */
export interface ProfileIntegrations {
  /** The owner's own records on this host, for a read. */
  list(owner: ProfileIntegrationOwner): Integration[]
  /** The owner's own record with this URL. */
  findByUrl(owner: ProfileIntegrationOwner, url: string): Integration | null
  create(owner: ProfileIntegrationOwner, entry: AgentProfileIntegrationEntry): Integration
  update(id: string, entry: AgentProfileIntegrationEntry): void
  remove(id: string): void
}

/** The person's account, for a pull (plans/020 §4). Absent on a host that is never linked. */
export interface ProfileAccount {
  /** The person's account, read with this host's delegation for them (ADR 0001 §2.2 rule 7). */
  reads: Pick<AccountReads, 'fetch'>
  /** Whose account a target's profile is: a member's own, or the host owner's; null when the owner is not known yet. */
  userFor: (target: AgentProfileTarget) => string | null
  /** After a pull: the person's host-local MCP connections move into their account (§5.4). */
  reconcile?: (owner: ProfileIntegrationOwner, cloudConnections: VaultConnection[]) => Promise<void>
}

export interface AgentProfileDeps {
  /** The homes this machine's profile is read from, per provider; first one wins a path. */
  sourceHomes: (provider: SeatProvider) => string[]
  /** The folder the target's agent reads for a provider: where their profile is written. */
  homeFor: (target: AgentProfileTarget, provider: SeatProvider) => string
  /** The OS user a target's files are written as where each member is their own user; absent or null: the server's own. */
  processUserFor?: (target: AgentProfileTarget) => ProcessUser | null
  now: () => number
  skills: ProfileSkills
  integrations: ProfileIntegrations
  /** Whose records a target's integrations become; the owner's own on a read. */
  integrationOwnerFor: (target: AgentProfileTarget) => ProfileIntegrationOwner
  account?: ProfileAccount
}

/** The records a copy now owns, and the servers it left to the host. */
interface IntegrationApplyOutcome {
  ids: string[]
  skipped: AgentProfileSkip[]
}

/** A host record as the profile names it: the record, never its connection. */
function integrationEntryOf(integration: Integration): AgentProfileIntegrationEntry {
  return { kind: 'integration', slug: integration.slug, name: integration.name, url: integration.url, auth: integration.auth }
}

function byKind(profile: AgentProfile) {
  const files: AgentProfileFileEntry[] = []
  const skills: AgentProfileSkillEntry[] = []
  const integrations: AgentProfileIntegrationEntry[] = []
  // A retired entry (a home's CLAUDE.md or AGENTS.md from an older copy) is left out, not a refusal of the whole profile.
  for (const entry of Object.values(withoutRetiredEntries(profile))) {
    if (entry.kind === 'file') files.push(entry)
    else if (entry.kind === 'skill') skills.push(entry)
    else integrations.push(entry)
  }
  // The two appliers would fight over one folder.
  for (const skill of skills) {
    if (files.some((file) => file.path.startsWith(`skills/${skill.name}/`))) throw new Error(`"${skill.name}" is both a registry skill and a hand-written skill.`)
  }
  return { files, skills, integrations }
}

export class AgentProfileManager {
  constructor(private readonly deps: AgentProfileDeps) {}

  /**
   * This machine's profile: its files, its registry skills as references, and
   * the host's own MCP servers as records. What does not fit is reported.
   */
  async read(): Promise<AgentProfileCopy> {
    const entries: AgentProfileEntry[] = []
    const installed = await this.deps.skills.list()
    // A skill a profile placed here is the account's, not this machine's own.
    const registrySkills = new Set<string>(this.manifestFor({ kind: 'owner' })?.skills ?? [])
    if (installed.ok) {
      for (const skill of installed.skills) {
        if (!skill.source) continue
        registrySkills.add(skill.name)
        entries.push({ kind: 'skill', name: skill.name, source: skill.source, skillId: skill.name })
      }
    }
    const { files, skipped } = readProfileFiles(this.deps.sourceHomes, registrySkills)
    entries.push(...files)
    for (const integration of this.deps.integrations.list(this.deps.integrationOwnerFor({ kind: 'owner' }))) {
      entries.push(integrationEntryOf(integration))
    }
    return { profile: agentProfileFrom(entries), skipped }
  }

  /**
   * Make the target's homes and records match the copy: entries it no longer
   * holds are removed, the rest written or installed. Anything else in a home —
   * the login, the transcript link, what the person made there — is left alone.
   * An empty profile removes the copy.
   */
  async apply(target: AgentProfileTarget, copy: AgentProfileCopy, origin: AgentProfileOrigin): Promise<AgentProfileStatus> {
    const { files, skills, integrations } = byKind(copy.profile)
    const user = this.deps.processUserFor?.(target) ?? null
    // A member who is their own user owns their home: a missing agent folder is made as them.
    const missingHomes = SEAT_PROVIDERS.map((provider) => this.deps.homeFor(target, provider)).filter((home) => !existsSync(home))
    applyMemberFiles(user, missingHomes.map((path) => ({ kind: 'folder', path, mode: 0o750 })))
    const previousFor = (provider: SeatProvider) => this.readManifest(this.deps.homeFor(target, provider))?.files ?? []
    const registry = await this.registryFiles(skills, previousFor)
    const writes = planProfileFiles({
      entries: [...files, ...registry.files],
      skipped: [...copy.skipped, ...registry.retained],
      homeFor: (provider) => this.deps.homeFor(target, provider),
      previousFor,
      ownerHost: target.kind === 'owner',
    })
    const syncedAt = this.deps.now()
    const writtenFiles = new Map<SeatProvider, string[]>()
    const kept: AgentProfileSkip[] = []
    for (const write of writes) {
      writtenFiles.set(write.provider, writeProfileFiles(write, user))
      kept.push(...write.kept)
    }
    const integrationOutcome = this.applyIntegrations(target, integrations, this.manifestFor(target)?.integrations ?? [], origin)
    const held = [...copy.skipped, ...kept, ...registry.failed, ...integrationOutcome.skipped]
    const empty = Object.keys(copy.profile).length === 0 && copy.skipped.length === 0
    for (const provider of SEAT_PROVIDERS) {
      const home = resolvedHome(this.deps.homeFor(target, provider))
      const manifestPath = join(home, MANIFEST_FILE)
      const ownFiles = writtenFiles.get(provider) ?? []
      if (empty && ownFiles.length === 0) {
        applyMemberFiles(user, [{ kind: 'remove', path: manifestPath }])
        continue
      }
      const manifest: Manifest = {
        version: 2,
        source: origin.kind,
        revision: origin.kind === 'account' ? origin.revision : null,
        syncedAt,
        files: ownFiles,
        skills: registry.placed,
        integrations: integrationOutcome.ids,
        skipped: held.filter((skip) => !skip.provider || skip.provider === provider),
      }
      applyMemberFiles(user, [{ kind: 'write', path: manifestPath, content: JSON.stringify(manifest), mode: 0o600 }])
    }
    log.info('agent_profile_applied', { target: target.kind, source: origin.kind, files: files.length, skills: skills.length, integrations: integrations.length })
    return this.status(target)
  }

  /** Remove every profile entry this host copied for the target. */
  remove(target: AgentProfileTarget): Promise<AgentProfileStatus> {
    return this.apply(target, { profile: {}, skipped: [] }, { kind: 'computer' })
  }

  status(target: AgentProfileTarget): AgentProfileStatus {
    const manifests = SEAT_PROVIDERS.map((provider) => this.readManifest(this.deps.homeFor(target, provider))).filter((manifest) => manifest !== null)
    if (manifests.length === 0) return EMPTY_AGENT_PROFILE_STATUS
    const [first] = manifests
    const skipped = manifests.flatMap((manifest) => manifest.skipped)
    return {
      syncedAt: Math.max(...manifests.map((manifest) => manifest.syncedAt)),
      source: first.source,
      revision: first.revision,
      counts: {
        // A registry skill's files count as the skill, not as files.
        files: manifests.reduce((count, manifest) => count + manifest.files.filter((path) => !manifest.skills.includes(path.split('/')[1] ?? '') || !path.startsWith('skills/')).length, 0),
        skills: first.skills.length,
        integrations: first.integrations.length,
      },
      // A skip without a provider was recorded in every home; count it once.
      skipped: skipped.filter((skip, index) => skip.provider || skipped.findIndex((each) => each.path === skip.path && each.reason === skip.reason) === index),
    }
  }

  // ── The pull (plans/020 §4): the person's account is the source ──

  /**
   * Read the target's profile from their account with their token, apply it
   * when the account revision moved, then move their host-local MCP connections
   * into the account. The document holds no secret; a credential is fetched per
   * call by the gateway, never here. Refusals name their reason.
   */
  async pull(target: AgentProfileTarget): Promise<AgentProfileStatus> {
    const account = this.deps.account
    if (!account) throw new AgentProfileRefused('NOT_LINKED', 'This host is not linked to Solus Cloud.')
    const read = await this.readAccount(account, target)
    const { connections } = read
    const held = this.manifestFor(target)
    // The target's own MCP servers the profile does not name yet join it: signed in, the
    // account is the one list. A record a pull put here and the profile dropped is going, not new.
    const adopted = this.unnamedRecords(target, read.profile?.entries ?? {}, held?.integrations ?? [])
    // A retired entry the account still holds leaves it here, in the same write, so no client lists it again.
    const retired = retiredAgentProfileKeys(read.profile?.entries ?? {})
    const changed = adopted.length > 0 || retired.length > 0
    const profile = changed ? await this.writeEntries(target, agentProfileFrom(adopted), retired) ?? read.profile : read.profile
    if (adopted.length > 0) log.info('agent_profile_adopted_integrations', { target: target.kind, count: adopted.length })
    if (retired.length > 0) log.info('agent_profile_removed_retired_entries', { target: target.kind, count: retired.length })
    let status: AgentProfileStatus
    // No synced profile: a copy pushed from the computer stays as it is. The connections still apply.
    if (!profile || profile.revision === null) status = this.status(target)
    else if (held?.source === 'account' && held.revision === profile.revision) status = this.status(target)
    else {
      log.info('agent_profile_pulled', { target: target.kind, revision: profile.revision })
      status = await this.apply(target, { profile: profile.entries, skipped: [] }, { kind: 'account', revision: profile.revision })
    }
    await account.reconcile?.(this.deps.integrationOwnerFor(target), connections).catch((error) => {
      log.warn('agent_profile_reconcile_failed', { target: target.kind, error: error instanceof Error ? error.message : String(error) })
    })
    return status
  }

  /** The target's profile and connection statuses from their account; refusals name their reason. */
  private async readAccount(account: ProfileAccount, target: AgentProfileTarget): Promise<AccountRead> {
    const userId = account.userFor(target)
    if (!userId) throw new AgentProfileRefused('NO_TOKEN', 'This host cannot read your account right now. Sign in again.')
    const response = await account.reads.fetch(userId, null, AGENT_PROFILE_READ_PATH, { method: 'POST' })
    if (!(response instanceof Response)) {
      if (response.refused === 'NOT_LINKED') throw new AgentProfileRefused('NOT_LINKED', 'This host is not linked to Solus Cloud.')
      if (response.refused === 'NO_DELEGATION') throw new AgentProfileRefused('NO_TOKEN', 'This host cannot read your account right now. Sign in again.')
      log.warn('agent_profile_pull_unreachable', { error: response.message })
      throw new AgentProfileRefused('UNREACHABLE', 'Solus Cloud is unreachable.')
    }
    if (!response.ok) {
      log.warn('agent_profile_pull_refused', { status: response.status })
      throw new AgentProfileRefused('REFUSED', `Solus Cloud refused the read (${response.status}).`)
    }
    const parsed = accountReadSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success || 'error' in parsed.data) throw new AgentProfileRefused('REFUSED', 'Solus Cloud answered with something that is not a profile.')
    return parsed.data
  }

  /**
   * One of the target's own MCP servers was added or changed on this host
   * (Settings → MCP, or an agent): signed in, it is part of their profile, so the
   * change goes to the account and every host follows. A server that is not the
   * target's own, or a host that is not linked, changes nothing here.
   */
  async integrationSaved(target: AgentProfileTarget, integration: Integration): Promise<void> {
    if (!this.isOwnRecord(target, integration)) return
    await this.writeEntries(target, agentProfileFrom([integrationEntryOf(integration)]), [])
    await this.pullQuietly(target)
  }

  /**
   * One of the target's own MCP servers is about to be removed on this host: it
   * leaves the profile first, so no host, this one included, brings it back. A
   * cloud that does not answer refuses the removal rather than let the next pull
   * restore the server. Not signed in, the removal is this host's alone.
   */
  async integrationRemoving(target: AgentProfileTarget, integration: Integration): Promise<void> {
    if (!this.isOwnRecord(target, integration)) return
    try {
      await this.writeEntries(target, {}, [agentProfileKeyOf(integrationEntryOf(integration))])
    } catch (error) {
      if (error instanceof AgentProfileRefused && (error.code === 'NOT_LINKED' || error.code === 'NO_TOKEN')) return
      throw error
    }
  }

  /** The target's own records whose URL no profile entry names, and that no pull put here. */
  private unnamedRecords(target: AgentProfileTarget, profile: AgentProfile, owned: string[]): AgentProfileIntegrationEntry[] {
    const named = new Set(Object.values(profile).flatMap((entry) => entry.kind === 'integration' ? [entry.url] : []))
    const pulled = new Set(owned)
    return this.deps.integrations.list(this.deps.integrationOwnerFor(target))
      .filter((integration) => !named.has(integration.url) && !pulled.has(integration.id))
      .map(integrationEntryOf)
  }

  private isOwnRecord(target: AgentProfileTarget, integration: Integration): boolean {
    const owner = this.deps.integrationOwnerFor(target)
    return integration.organizationId === owner.organizationId && integration.ownerKey === owner.ownerKey
  }

  /**
   * The host's own change to the person's profile, merged into the current
   * revision by the account. Null when this host is not linked or holds no token
   * for the person: then there is no account to write to.
   */
  private async writeEntries(target: AgentProfileTarget, set: AgentProfile, reset: AgentProfileKey[]): Promise<AccountAgentProfileResponse | null> {
    const account = this.deps.account
    const userId = account?.userFor(target)
    if (!account || !userId) return null
    const body: AgentProfileEntriesWrite = { set, reset }
    const response = await account.reads.fetch(userId, null, AGENT_PROFILE_ENTRIES_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!(response instanceof Response)) {
      if (response.refused === 'NOT_LINKED' || response.refused === 'NO_DELEGATION') return null
      throw new AgentProfileRefused('UNREACHABLE', 'Solus Cloud is unreachable, so your agent profile cannot change right now. Try again.')
    }
    if (!response.ok) throw new AgentProfileRefused('REFUSED', `Solus Cloud refused the change to your agent profile (${response.status}).`)
    const parsed = accountAgentProfileResponseSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new AgentProfileRefused('REFUSED', 'Solus Cloud answered with something that is not a profile.')
    return parsed.data
  }

  /** A pull whose refusal is a log line: the triggers that are not a person's own request. */
  async pullQuietly(target: AgentProfileTarget): Promise<void> {
    try {
      await this.pull(target)
    } catch (error) {
      if (error instanceof AgentProfileRefused && error.code === 'NOT_LINKED') return
      log.info('agent_profile_pull_skipped', { target: target.kind, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Pull for every target `targets` names, now and every interval. Returns the stop. */
  startPeriodic(targets: () => AgentProfileTarget[], intervalMs = AGENT_PROFILE_PULL_INTERVAL_MS): () => void {
    const sweep = () => {
      for (const target of targets()) void this.pullQuietly(target)
    }
    sweep()
    const timer = setInterval(sweep, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  // ── The appliers ──

  /**
   * Registry skills as profile files: each skill's files under `skills/<name>/`
   * in every provider home, so they are written, kept, and removed with the rest
   * of the profile, as the person. A skill whose files cannot be read keeps what
   * an earlier copy wrote there, and is reported.
   */
  private async registryFiles(entries: AgentProfileSkillEntry[], previousFor: (provider: SeatProvider) => string[]): Promise<{
    files: AgentProfileFileEntry[]
    /** The earlier copy's files of a skill that could not be read: kept as they are. */
    retained: AgentProfileSkip[]
    placed: string[]
    failed: AgentProfileSkip[]
  }> {
    const files: AgentProfileFileEntry[] = []
    const retained: AgentProfileSkip[] = []
    const placed: string[] = []
    const failed: AgentProfileSkip[] = []
    for (const entry of entries) {
      let skillFiles: RegistrySkillFile[]
      try {
        skillFiles = await this.deps.skills.files(entry)
      } catch (error) {
        log.warn('agent_profile_skill_unavailable', { skillName: entry.name, source: entry.source, error: error instanceof Error ? error.message : String(error) })
        failed.push({ path: entry.name, reason: 'install-failed' })
        for (const provider of SEAT_PROVIDERS) {
          for (const path of previousFor(provider)) if (path.startsWith(`skills/${entry.name}/`)) retained.push({ provider, path, reason: 'install-failed' })
        }
        continue
      }
      placed.push(entry.name)
      for (const provider of SEAT_PROVIDERS) {
        for (const file of skillFiles) {
          const written: AgentProfileFileEntry = { kind: 'file', provider, path: `skills/${entry.name}/${file.path}`, contentBase64: file.content.toString('base64'), hash: sha256Hex(file.content) }
          if (file.executable) written.executable = true
          files.push(written)
        }
      }
    }
    return { files, retained, placed, failed }
  }

  /**
   * MCP servers as the target's own records: matched by URL, never by id, so a
   * record another host made is adopted, not duplicated. From the account, the
   * person's own records are the profile's to manage, so it adopts them too;
   * from a computer's push, a server a host the person owns already had is kept
   * as it is.
   */
  private applyIntegrations(target: AgentProfileTarget, entries: AgentProfileIntegrationEntry[], previous: string[], origin: AgentProfileOrigin): IntegrationApplyOutcome {
    const owner = this.deps.integrationOwnerFor(target)
    const owned = new Set(previous)
    const ids: string[] = []
    const skipped: AgentProfileSkip[] = []
    for (const entry of entries) {
      const found = this.deps.integrations.findByUrl(owner, entry.url)
      if (!found) {
        ids.push(this.deps.integrations.create(owner, entry).id)
        continue
      }
      // A record this copy made is its own to update. A member's own record made
      // another way is adopted. Anything else the host already had stays as it is.
      if (owned.has(found.id) || target.kind === 'member' || origin.kind === 'account') {
        this.deps.integrations.update(found.id, entry)
        ids.push(found.id)
      } else skipped.push({ path: entry.slug, reason: 'kept-on-host' })
    }
    for (const id of previous) if (!ids.includes(id)) this.deps.integrations.remove(id)
    return { ids, skipped }
  }

  /** The first home's manifest: the source and revision a copy came from, and what it owns. */
  private manifestFor(target: AgentProfileTarget): Manifest | null {
    for (const provider of SEAT_PROVIDERS) {
      const manifest = this.readManifest(this.deps.homeFor(target, provider))
      if (manifest) return manifest
    }
    return null
  }

  private readManifest(home: string): Manifest | null {
    const path = join(home, MANIFEST_FILE)
    if (!existsSync(path)) return null
    try {
      return manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return null
    }
  }
}
