import {
  agentProfileKeyOf,
  type AgentProfile,
  type AgentProfileEntry,
  type AgentProfileFileEntry,
  type AgentProfileIntegrationEntry,
  type AgentProfileKey,
  type AgentProfileSkillEntry,
  type AgentProfileStatus,
} from '@solus/contracts/agent-profile'
import { integrationSlug, type IntegrationProbeResult } from '@solus/contracts/integration-types'
import type { SeatProvider } from '@solus/contracts/seats'
import { MODEL_PROFILES, type RemoteSkill } from '@solus/contracts/types'
import type { DocumentSyncUnavailable } from '@solus/client-core/document-sync'
import { InstalledIntegration, urlHost, type ConnectionListState, type InstalledStatus, type IntegrationListState } from '../integrations'

/**
 * The agent profile as the phone shows and edits it (plans/020-agent-profile.md
 * §1, §3): the entries by part, and the one entry each add makes. A phone has
 * no provider home, so a file entry travels as the host made it; nothing is
 * encoded here.
 */

export const PROVIDER_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
} as const satisfies Record<SeatProvider, string>

export const SEAT_PROVIDERS: readonly SeatProvider[] = ['claude-code', 'codex']

// ─── Bytes ───

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let written = 0
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((offset) => BASE64_ALPHABET.indexOf(clean[i + offset] ?? 'A'))
    const triple = (chunk[0]! << 18) | (chunk[1]! << 12) | (chunk[2]! << 6) | chunk[3]!
    const count = Math.min(3, clean.length - i - 1)
    for (let n = 0; n < count; n += 1) bytes[written++] = (triple >> (16 - n * 8)) & 255
  }
  return bytes.subarray(0, written)
}

// ─── Entries ───

/** A registry skill as the host installs it: `skills add <source>@<skillId>`. */
export function skillEntryFromRemote(skill: RemoteSkill): AgentProfileSkillEntry {
  return { kind: 'skill', name: skill.name, source: skill.repo, skillId: skill.name }
}

/** The record a probed server becomes: named after its host, with the auth the probe found. Null when the probe could not place it. */
export function integrationEntryFromProbe(url: string, probe: IntegrationProbeResult): AgentProfileIntegrationEntry | null {
  if (probe.outcome === 'undetermined') return null
  const name = urlHost(url.trim())
  return { kind: 'integration', slug: integrationSlug(name), name, url: url.trim(), auth: probe.auth, disabledTools: [] }
}

/** A long list shows this many rows before "Show more". */
export const PROFILE_PAGE_SIZE = 8

/** One page of a long list: the rows shown, and how many wait behind "Show more". */
export interface ListPage<T> {
  rows: readonly T[]
  hiddenCount: number
}

/** The rows a list shows, and how many it hides: all of them, or the first page. */
export function pageOf<T>(items: readonly T[], expanded: boolean): ListPage<T> {
  if (expanded || items.length <= PROFILE_PAGE_SIZE) return { rows: items, hiddenCount: 0 }
  return { rows: items.slice(0, PROFILE_PAGE_SIZE), hiddenCount: items.length - PROFILE_PAGE_SIZE }
}

/** A hand-written skill: the files under `skills/<name>/` of one provider. */
export interface HandWrittenSkill {
  name: string
  provider: SeatProvider
  keys: AgentProfileKey[]
}

export interface AgentProfileParts {
  /** Files that are not a skill's, by provider then path. */
  files: AgentProfileFileEntry[]
  handWrittenSkills: HandWrittenSkill[]
  registrySkills: AgentProfileSkillEntry[]
  integrations: AgentProfileIntegrationEntry[]
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

export function agentProfileParts(entries: AgentProfile): AgentProfileParts {
  const files: AgentProfileFileEntry[] = []
  const skillsByFolder = new Map<string, HandWrittenSkill>()
  const registrySkills: AgentProfileSkillEntry[] = []
  const integrations: AgentProfileIntegrationEntry[] = []
  for (const entry of Object.values(entries)) {
    if (entry.kind === 'skill') registrySkills.push(entry)
    else if (entry.kind === 'integration') integrations.push(entry)
    else if (entry.path.startsWith('skills/')) {
      const name = entry.path.split('/')[1] ?? ''
      const id = `${entry.provider}/${name}`
      const skill = skillsByFolder.get(id) ?? { name, provider: entry.provider, keys: [] }
      skill.keys.push(agentProfileKeyOf(entry))
      skillsByFolder.set(id, skill)
    } else files.push(entry)
  }
  files.sort((a, b) => {
    if (a.provider !== b.provider) return SEAT_PROVIDERS.indexOf(a.provider) - SEAT_PROVIDERS.indexOf(b.provider)
    return a.path.localeCompare(b.path)
  })
  return {
    files,
    handWrittenSkills: [...skillsByFolder.values()].sort(byName),
    registrySkills: registrySkills.sort(byName),
    integrations: integrations.sort(byName),
  }
}

// ─── Words ───

/** `file:claude-code/agents/reviewer.md` → "agents/reviewer.md (Claude Code)"; a skill or server by its name. */
export function entryKeyLabel(key: AgentProfileKey): string {
  const file = /^file:(claude-code|codex)\/(.+)$/.exec(key)
  if (file) return `${file[2]} (${PROVIDER_LABELS[file[1] === 'codex' ? 'codex' : 'claude-code']})`
  if (key.startsWith('skill:')) return `Skill ${key.slice('skill:'.length)}`
  return `MCP server ${key.slice('integration:'.length)}`
}

/** One side of a conflict, short enough for a note. */
export function entryValueText(document: AgentProfile, key: AgentProfileKey): string {
  const entry: AgentProfileEntry | undefined = document[key]
  if (!entry) return 'Removed'
  switch (entry.kind) {
    case 'file': {
      const text = new TextDecoder().decode(decodeBase64(entry.contentBase64)).replace(/\s+/g, ' ').trim()
      return text.length === 0 ? 'Empty' : text.length > 60 ? `${text.slice(0, 57)}…` : text
    }
    case 'skill':
      return `${entry.source}@${entry.skillId}`
    case 'integration':
      return `${entry.name}, ${urlHost(entry.url)}, ${AUTH_LABELS[entry.auth.kind]}`
  }
}

export const AUTH_LABELS = {
  none: 'No sign-in',
  bearer: 'API key',
  oauth: 'OAuth sign-in',
} as const satisfies Record<AgentProfileIntegrationEntry['auth']['kind'], string>

/** `3 files, 2 skills, 1 MCP server`; the parts that are zero are left out. */
export function agentProfileCounts(counts: AgentProfileStatus['counts']): string {
  const parts = [
    counts.files > 0 ? `${counts.files} ${counts.files === 1 ? 'file' : 'files'}` : null,
    counts.skills > 0 ? `${counts.skills} ${counts.skills === 1 ? 'skill' : 'skills'}` : null,
    counts.integrations > 0 ? `${counts.integrations} ${counts.integrations === 1 ? 'MCP server' : 'MCP servers'}` : null,
  ].filter((part) => part !== null)
  return parts.length ? parts.join(', ') : 'nothing'
}

/** The line under a host: where its copy came from and what it holds, or why the last call failed. */
export function hostProfileText(status: AgentProfileStatus | null, error: string | null, formatTime: (epochMs: number) => string): string {
  if (error) return error
  if (!status) return 'Not read yet.'
  if (status.syncedAt === null) return 'Not on this host yet.'
  const from = status.source === 'account' ? 'from your account' : 'from your computer'
  const keptOnHost = status.skipped.filter((skip) => skip.reason === 'kept-on-host').length
  const failed = status.skipped.filter((skip) => skip.reason === 'install-failed').length
  const notSent = status.skipped.length - keptOnHost - failed
  const kept = keptOnHost > 0 ? ` ${keptOnHost} kept as this host already had them.` : ''
  const installs = failed > 0 ? ` ${failed} ${failed === 1 ? 'skill' : 'skills'} could not be installed.` : ''
  const skipped = notSent > 0 ? ` ${notSent} left out: over the size limit or unreadable.` : ''
  return `Copied ${from} ${formatTime(status.syncedAt)}: ${agentProfileCounts(status.counts)}.${kept}${installs}${skipped}`
}

/** Why turning sync on or clearing it did not reach Solus Cloud. */
export function syncUnavailableText(outcome: DocumentSyncUnavailable): string {
  if (outcome.kind === 'signed-out') return 'Sign in to Solus Cloud again to sync.'
  if (outcome.kind === 'offline') return 'Solus Cloud did not answer. Check your connection.'
  return `Solus Cloud refused: ${outcome.message ?? outcome.code}.`
}

export function skillFileCountText(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

// ─── Per-model instructions ───

/** A model the person can give its own instructions. */
export interface ModelInstructionChoice {
  model: string
  label: string
  providerLabel: string
}

/**
 * The models the per-model instructions list offers: each agent's models from
 * the shared model profiles, in agent order. Instructions are keyed by model id
 * alone, so an id an earlier agent lists is not listed again. A legacy model
 * stays listed while it has instructions, so they can still be seen and cleared.
 */
export function modelInstructionChoices(saved: Readonly<Record<string, string>>): ModelInstructionChoice[] {
  const seen = new Set<string>()
  const choices: ModelInstructionChoice[] = []
  for (const provider of SEAT_PROVIDERS) {
    for (const [model, profile] of Object.entries(MODEL_PROFILES[provider] ?? {})) {
      if (seen.has(model) || (profile.isLegacy && !saved[model]?.trim())) continue
      seen.add(model)
      choices.push({ model, label: profile.label, providerLabel: PROVIDER_LABELS[provider] })
    }
  }
  return choices
}

/**
 * A profile server on one host: the status of the host's record of it, found
 * by address, or "Not added yet" until the profile reaches the host. Connect
 * opens that host's MCP screen, which adds the server on the way, so only a
 * server that asks for a sign-in offers it. Null when the host cannot say.
 */
export function profileServerStatus(
  entry: AgentProfileIntegrationEntry,
  list: IntegrationListState,
  connections: ConnectionListState,
): InstalledStatus | null {
  if (list.kind === 'loading') return { text: 'Checking…', tone: 'muted', action: null }
  if (list.kind !== 'loaded') return null
  const integration = list.integrations.find((item) => item.url === entry.url)
  if (!integration) return { text: 'Not added yet', tone: 'muted', action: entry.auth.kind === 'none' ? null : 'connect' }
  return new InstalledIntegration(integration).status(connections)
}
