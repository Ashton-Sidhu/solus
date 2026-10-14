/**
 * A person's agent profile (docs/agent-profile.md, plans/020-agent-profile.md):
 * the instructions, skills, subagents, commands, and MCP servers that make an
 * agent work their way. It is pushed from the machine the person works on when
 * they are not signed in, and pulled from their account by every host they
 * have a seat on when they are. Logins, settings, plugins, and transcripts are
 * not part of it; a credential never is.
 *
 * The profile is a flat map from entry key to entry. The key is derived from
 * the entry (`agentProfileKeyOf`), and one key is one conflict unit, so the
 * document sync engine applies to it without change.
 */

import { z } from 'zod'
import { integrationAuthSchema } from './integration-types'
import { seatProviderSchema, type SeatProvider } from './seats'

/**
 * What each provider home contributes, as the first segment of a file path.
 * The home's `CLAUDE.md` and `AGENTS.md` are not part of it: an instructions
 * file belongs with a project, and a person's own instructions are the extra
 * instructions of their settings, which every prompt carries (plans/020 §10).
 */
export const AGENT_PROFILE_ENTRIES = {
  'claude-code': ['skills', 'agents', 'commands'],
  codex: ['skills', 'prompts'],
} as const satisfies Record<SeatProvider, readonly string[]>

/** A file larger than this is left out and reported. */
export const AGENT_PROFILE_MAX_FILE_BYTES = 1024 * 1024
/** Files past this total are left out and reported. */
export const AGENT_PROFILE_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const AGENT_PROFILE_MAX_ENTRIES = 5000
export const AGENT_PROFILE_SCHEMA_VERSION = 1

const PATH_MAX_LENGTH = 512
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

export const agentProfileEntrySchema = z.discriminatedUnion('kind', [
  /** One file of a provider home: an instruction file, a subagent, a command, a prompt, or a hand-written skill's file. */
  z.object({
    kind: z.literal('file'),
    provider: seatProviderSchema,
    /** Relative to the provider's home, `/`-separated: `skills/review/SKILL.md`. */
    path: z.string().min(1).max(PATH_MAX_LENGTH),
    contentBase64: z.string(),
    executable: z.boolean().optional(),
    /** SHA-256 of the content, hex, so two copies compare without decoding. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  /** A skill installed from skills.sh: a reference the host installs with the skills CLI, never its files. */
  z.object({
    kind: z.literal('skill'),
    name: z.string().regex(SKILL_NAME),
    /** The registry source, `owner/repo`, as `skills list` reports it. */
    source: z.string().min(1).max(200),
    skillId: z.string().regex(SKILL_NAME),
  }).strict(),
  /** An MCP server the person added: its record, never a key, a token, or an OAuth client. */
  z.object({
    kind: z.literal('integration'),
    slug: z.string().regex(SLUG),
    name: z.string().trim().min(1).max(200),
    url: z.string().min(1).max(4096),
    auth: integrationAuthSchema,
  }).strict(),
])
/** An entry is in the profile, and on every host the person has a seat on; removing it takes it off every host. */
export type AgentProfileEntry = z.infer<typeof agentProfileEntrySchema>
export type AgentProfileFileEntry = Extract<AgentProfileEntry, { kind: 'file' }>
export type AgentProfileSkillEntry = Extract<AgentProfileEntry, { kind: 'skill' }>
export type AgentProfileIntegrationEntry = Extract<AgentProfileEntry, { kind: 'integration' }>

export type AgentProfileKey = `file:${SeatProvider}/${string}` | `skill:${string}` | `integration:${string}`

/** The one key an entry has. Every writer derives it here; a host applies entries by their content. */
export function agentProfileKeyOf(entry: AgentProfileEntry): AgentProfileKey {
  switch (entry.kind) {
    case 'file':
      return `file:${entry.provider}/${entry.path}`
    case 'skill':
      return `skill:${entry.name}`
    case 'integration':
      return `integration:${entry.slug}`
  }
}

export const agentProfileKeySchema = z.string().regex(/^(file:(claude-code|codex)\/.+|skill:.+|integration:.+)$/).max(PATH_MAX_LENGTH + 24)

/** The profile: its entries by key. An empty map removes the profile from a host. */
export const agentProfileSchema = z.record(agentProfileKeySchema, agentProfileEntrySchema)
  .refine((entries) => Object.keys(entries).length <= AGENT_PROFILE_MAX_ENTRIES, 'The agent profile has more entries than a host accepts.')
export type AgentProfile = z.infer<typeof agentProfileSchema>

export function agentProfileFrom(entries: Iterable<AgentProfileEntry>): AgentProfile {
  const profile: AgentProfile = {}
  for (const entry of entries) profile[agentProfileKeyOf(entry)] = entry
  return profile
}

export function agentProfileByteLength(profile: AgentProfile): number {
  return new TextEncoder().encode(JSON.stringify(profile)).byteLength
}

/** Where a host's copy came from: a push from the person's computer, or a pull from their account. */
export const agentProfileSourceSchema = z.enum(['computer', 'account'])
export type AgentProfileSource = z.infer<typeof agentProfileSourceSchema>

export const agentProfileSkipSchema = z.object({
  provider: seatProviderSchema.optional(),
  /** A file path, a skill name, or an integration slug. */
  path: z.string().max(PATH_MAX_LENGTH),
  /**
   * `kept-on-host`: a host you own already has its own file, or its own
   * integration of that URL, which a copy never replaces. `install-failed`: the
   * skills CLI could not install a registry skill; the rest of the copy went on.
   */
  reason: z.enum(['file-too-large', 'profile-too-large', 'unreadable', 'kept-on-host', 'install-failed']),
}).strict()
export type AgentProfileSkip = z.infer<typeof agentProfileSkipSchema>

/** A profile as it moves between a computer and a host: what `agentProfileRead` answers and `agentProfileApply` takes, with what did not fit. */
export const agentProfileCopySchema = z.object({
  profile: agentProfileSchema,
  skipped: z.array(agentProfileSkipSchema).max(AGENT_PROFILE_MAX_ENTRIES).default([]),
}).strict()
export type AgentProfileCopy = z.infer<typeof agentProfileCopySchema>

/** The caller's profile on a host: where it came from, when, and what it holds. */
export const agentProfileStatusSchema = z.object({
  /** Null when no profile was ever copied here, or it was removed. */
  syncedAt: z.number().nullable(),
  source: agentProfileSourceSchema.nullable(),
  /** The account revision a pulled profile came from; null for a push. */
  revision: z.number().int().nullable(),
  counts: z.object({ files: z.number().int(), skills: z.number().int(), integrations: z.number().int() }),
  skipped: z.array(agentProfileSkipSchema),
})
export type AgentProfileStatus = z.infer<typeof agentProfileStatusSchema>

export const EMPTY_AGENT_PROFILE_STATUS: AgentProfileStatus = Object.freeze({ syncedAt: null, source: null, revision: null, counts: { files: 0, skills: 0, integrations: 0 }, skipped: [] })

// ─── The account document (the cloud half: solus-cloud/docs/plans/agent-profile.md) ───

export const AGENT_PROFILE_PATH = '/v1/account/agent-profile'

/** `GET /v1/account/agent-profile`: the person's synced profile. `revision` is null before the first write of a generation. */
export const accountAgentProfileResponseSchema = z.object({
  schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
  generation: z.number().int().nonnegative(),
  revision: z.number().int().positive().nullable(),
  entries: agentProfileSchema,
  updatedAt: z.number().nullable(),
})
export type AccountAgentProfileResponse = z.infer<typeof accountAgentProfileResponseSchema>

/**
 * `PATCH /v1/account/agent-profile`. `set` replaces each key it carries; `reset`
 * removes keys. The conflict unit is one key. `expectedRevision: null` creates the
 * document and fails when one already exists.
 */
export const accountAgentProfilePatchRequestSchema = z.object({
  generation: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive().nullable(),
  set: agentProfileSchema,
  reset: z.array(agentProfileKeySchema).max(AGENT_PROFILE_MAX_ENTRIES).default([]),
}).strict()
export type AccountAgentProfilePatchRequest = z.input<typeof accountAgentProfilePatchRequestSchema>

/**
 * `POST /v1/agent-profile/entries`, from a host acting for the person with their
 * delegated token: the host's own change to the person's MCP servers (one added,
 * renamed, or removed in Settings → MCP, or one the host held before the profile
 * named it), merged into the current revision. A host never sees a conflict: the
 * keys it names are the ones it changed. Answers the document after the merge.
 */
export const AGENT_PROFILE_ENTRIES_PATH = '/v1/agent-profile/entries'
export const agentProfileEntriesWriteSchema = z.object({
  set: agentProfileSchema,
  reset: z.array(agentProfileKeySchema).max(AGENT_PROFILE_MAX_ENTRIES).default([]),
}).strict()
export type AgentProfileEntriesWrite = z.input<typeof agentProfileEntriesWriteSchema>

/** A 409 on an account write: a stale revision or a cleared generation. */
export const accountAgentProfileConflictBodySchema = z.object({
  error: z.enum(['profile_conflict', 'profile_generation_changed']),
  current: accountAgentProfileResponseSchema,
})
