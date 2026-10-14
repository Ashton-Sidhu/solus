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
import type { AgentProfileConflict } from '@solus/client-core/agent-profile-sync'

/**
 * The agent profile document as the Settings page reads it (plans/020 §3):
 * the flat entries sorted into the page's four sections, the instruction file
 * of each provider encoded and decoded for its editor, and the words for a
 * key, a side of a conflict, and the sync state.
 */

const PROVIDER_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' } as const satisfies Record<SeatProvider, string>

export function providerLabel(provider: SeatProvider): string {
  return PROVIDER_LABELS[provider]
}

/** `skills/<name>/…`: the name, or null for a file outside the skills folder. */
function writtenSkillName(entry: AgentProfileFileEntry): string | null {
  const [folder, name] = entry.path.split('/')
  return folder === 'skills' && name ? name : null
}

/** One provider's files that are not a skill: subagents, commands, and prompts, listed and not edited. */
export interface FileGroup {
  provider: SeatProvider
  files: AgentProfileFileEntry[]
}

export interface WrittenSkill {
  name: string
  providers: SeatProvider[]
  keys: AgentProfileKey[]
  fileCount: number
}

export interface AgentProfileSections {
  /** One group per provider, in the contract's order, even when empty. */
  files: FileGroup[]
  registrySkills: AgentProfileSkillEntry[]
  writtenSkills: WrittenSkill[]
  integrations: AgentProfileIntegrationEntry[]
}

const PROVIDERS: readonly SeatProvider[] = ['claude-code', 'codex']

/** The page's four sections, each sorted by name so the list is stable between edits. */
export function sectionsOf(entries: AgentProfile): AgentProfileSections {
  const files: FileGroup[] = PROVIDERS.map((provider) => ({ provider, files: [] }))
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
      files.find((candidate) => candidate.provider === entry.provider)?.files.push(entry)
    }
  }
  const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name)
  for (const group of files) group.files.sort((left, right) => left.path.localeCompare(right.path))
  return {
    files,
    registrySkills: registrySkills.sort(byName),
    writtenSkills: [...writtenSkills.values()].sort(byName),
    integrations: integrations.sort(byName),
  }
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

// ─── Paging ───

/** A long list shows this many rows before "Show more". */
export const PROFILE_PAGE_SIZE = 8

/** One page of a long list: the rows shown, and how many wait behind "Show more". */
export interface ListPage<T> {
  rows: readonly T[]
  hiddenCount: number
}

/** The rows a list shows, and the words for the rest: all of them, or the first page with "Show N more". */
export function pageOf<T>(items: readonly T[], expanded: boolean): ListPage<T> {
  if (expanded || items.length <= PROFILE_PAGE_SIZE) return { rows: items, hiddenCount: 0 }
  return { rows: items.slice(0, PROFILE_PAGE_SIZE), hiddenCount: items.length - PROFILE_PAGE_SIZE }
}
