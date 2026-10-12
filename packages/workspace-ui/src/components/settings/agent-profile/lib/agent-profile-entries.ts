import {
  agentProfileEntrySchema,
  agentProfileKeyOf,
  type AgentProfile,
  type AgentProfileFileEntry,
  type AgentProfileIntegrationEntry,
  type AgentProfileKey,
  type AgentProfileSkillEntry,
} from '@solus/contracts/agent-profile'
import { integrationSlug, type IntegrationAuth } from '@solus/contracts/integration-types'
import type { SeatProvider } from '@solus/contracts/seats'
import type { RemoteSkill } from '@solus/contracts/types'
import type { AgentProfileConflict, AgentProfileSyncStatus } from '@solus/client-core/agent-profile-sync'

/**
 * The agent profile document as the Settings page reads it (plans/020 §3):
 * the flat entries sorted into the page's four sections, the instruction file
 * of each provider encoded and decoded for its editor, and the words for a
 * key, a side of a conflict, and the sync state.
 */

/** The one instruction file of each provider home, editable in place. */
export const INSTRUCTION_FILES = { 'claude-code': 'CLAUDE.md', codex: 'AGENTS.md' } as const satisfies Record<SeatProvider, string>

const PROVIDER_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' } as const satisfies Record<SeatProvider, string>

export function providerLabel(provider: SeatProvider): string {
  return PROVIDER_LABELS[provider]
}

export function isInstructionFile(entry: AgentProfileFileEntry): boolean {
  return entry.path === INSTRUCTION_FILES[entry.provider]
}

/** `skills/<name>/…`: the name, or null for a file outside the skills folder. */
function writtenSkillName(entry: AgentProfileFileEntry): string | null {
  const [folder, name] = entry.path.split('/')
  return folder === 'skills' && name ? name : null
}

export interface InstructionGroup {
  provider: SeatProvider
  /** The provider's instruction file, when the profile holds it. */
  instructions: AgentProfileFileEntry | null
  /** Subagents, commands, and prompts: listed, not edited here. */
  otherFiles: AgentProfileFileEntry[]
}

export interface WrittenSkill {
  name: string
  providers: SeatProvider[]
  keys: AgentProfileKey[]
  fileCount: number
}

export interface AgentProfileSections {
  /** One group per provider, in the contract's order, even when empty. */
  instructions: InstructionGroup[]
  registrySkills: AgentProfileSkillEntry[]
  writtenSkills: WrittenSkill[]
  integrations: AgentProfileIntegrationEntry[]
}

const PROVIDERS: readonly SeatProvider[] = ['claude-code', 'codex']

/** The page's four sections, each sorted by name so the list is stable between edits. */
export function sectionsOf(entries: AgentProfile): AgentProfileSections {
  const instructions: InstructionGroup[] = PROVIDERS.map((provider) => ({ provider, instructions: null, otherFiles: [] }))
  const registrySkills: AgentProfileSkillEntry[] = []
  const writtenSkills = new Map<string, WrittenSkill>()
  const integrations: AgentProfileIntegrationEntry[] = []
  for (const entry of Object.values(entries)) {
    if (entry.kind === 'skill') registrySkills.push(entry)
    else if (entry.kind === 'integration') integrations.push(entry)
    else {
      const skillName = writtenSkillName(entry)
      if (skillName !== null) {
        const skill = writtenSkills.get(skillName) ?? { name: skillName, providers: [], keys: [], fileCount: 0 }
        if (!skill.providers.includes(entry.provider)) skill.providers.push(entry.provider)
        // The schema refuses a document whose key disagrees with its entry, so the entry's own key is the stored one.
        skill.keys.push(agentProfileKeyOf(entry))
        skill.fileCount += 1
        writtenSkills.set(skillName, skill)
        continue
      }
      const group = instructions.find((candidate) => candidate.provider === entry.provider)
      if (!group) continue
      if (isInstructionFile(entry)) group.instructions = entry
      else group.otherFiles.push(entry)
    }
  }
  const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name)
  for (const group of instructions) group.otherFiles.sort((left, right) => left.path.localeCompare(right.path))
  return {
    instructions,
    registrySkills: registrySkills.sort(byName),
    writtenSkills: [...writtenSkills.values()].sort(byName),
    integrations: integrations.sort(byName),
  }
}

// ─── File content ───

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The text of a file entry, for its editor. */
export function decodeFileText(entry: AgentProfileFileEntry): string {
  try {
    return new TextDecoder().decode(base64ToBytes(entry.contentBase64))
  } catch {
    return ''
  }
}

/** SHA-256 of the content, hex, as the contract hashes a file. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A file entry for edited text: its content encoded, and its hash as the host computes it. */
export async function encodeFileEntry(provider: SeatProvider, path: string, text: string): Promise<AgentProfileFileEntry> {
  const bytes = new TextEncoder().encode(text)
  return { kind: 'file', provider, path, contentBase64: bytesToBase64(bytes), hash: await sha256Hex(bytes) }
}

// ─── New entries ───

/** A registry reference for a skills.sh search result; null when the registry's id does not name a skill. */
export function skillEntryOf(skill: RemoteSkill): AgentProfileSkillEntry | null {
  const skillId = skill.id.split('@')[1] ?? ''
  const parsed = agentProfileEntrySchema.safeParse({ kind: 'skill', name: skill.name, source: skill.repo, skillId })
  return parsed.success && parsed.data.kind === 'skill' ? parsed.data : null
}

/** An MCP server entry for a probed address; null when the name or address does not fit the contract. */
export function integrationEntryOf(name: string, url: string, auth: IntegrationAuth): AgentProfileIntegrationEntry | null {
  const parsed = agentProfileEntrySchema.safeParse({ kind: 'integration', slug: integrationSlug(name), name: name.trim(), url, auth })
  return parsed.success && parsed.data.kind === 'integration' ? parsed.data : null
}

/** How a server authenticates, in two words. */
export function authKindLabel(auth: IntegrationAuth): string {
  switch (auth.kind) {
    case 'none': return 'No sign-in'
    case 'oauth': return 'OAuth sign-in'
    case 'bearer': return 'API key'
  }
}

// ─── Words ───

/** A key in words: "CLAUDE.md (Claude Code)", "Skill review", "MCP server deepwiki". */
export function agentProfileKeyLabel(key: AgentProfileKey): string {
  if (key.startsWith('skill:')) return `Skill ${key.slice('skill:'.length)}`
  if (key.startsWith('integration:')) return `MCP server ${key.slice('integration:'.length)}`
  const [provider, ...path] = key.slice('file:'.length).split('/')
  const label = provider === 'claude-code' || provider === 'codex' ? providerLabel(provider) : provider
  return `${path.join('/')} (${label})`
}

/** One side of a conflict, short: what that side holds, or "Removed" when that side reset the key. */
export function conflictSideText(side: AgentProfile, key: AgentProfileKey): string {
  const entry = side[key]
  if (!entry) return 'Removed'
  switch (entry.kind) {
    case 'file': return `${entry.contentBase64.length === 0 ? 'Empty' : 'Changed'} · ${entry.hash.slice(0, 8)}`
    case 'skill': return `${entry.source}@${entry.skillId}`
    case 'integration': return entry.url
  }
}

export interface ConflictRow {
  key: AgentProfileKey
  label: string
  mine: string
  theirs: string
}

export function conflictRows(conflicts: readonly AgentProfileConflict[]): ConflictRow[] {
  return conflicts.map((conflict) => ({
    key: conflict.key,
    label: agentProfileKeyLabel(conflict.key),
    mine: conflictSideText(conflict.mine, conflict.key),
    theirs: conflictSideText(conflict.theirs, conflict.key),
  }))
}

/** The words for the sync state. An optimistic edit never reads as synced. */
export function profileSyncStateLabel(status: AgentProfileSyncStatus): string {
  switch (status.state) {
    case 'signed-out': return 'Signed out'
    case 'off': return 'Off on this device'
    case 'loading': return 'Checking your account…'
    case 'synced': return 'Synced'
    case 'pending': return status.pendingKeys.length === 1 ? '1 change waiting to sync' : `${status.pendingKeys.length} changes waiting to sync`
    case 'offline': return 'Offline. Changes sync when you reconnect.'
    case 'conflict': return status.conflicts.length === 1 ? '1 entry changed on two devices' : `${status.conflicts.length} entries changed on two devices`
    case 'error': return status.error?.message ?? 'Sync stopped. Solus tries again later.'
  }
}

/** The names Settings search finds this page by: each skill, server, and file. */
export function agentProfileSearchWords(entries: AgentProfile): string[] {
  return Object.values(entries).map((entry) => {
    switch (entry.kind) {
      case 'file': return entry.path
      case 'skill': return entry.name
      case 'integration': return entry.name
    }
  })
}
