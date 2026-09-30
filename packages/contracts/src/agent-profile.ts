/**
 * A person's agent profile (docs/agent-profile.md): the instructions, skills,
 * subagents, and commands in their own Claude and Codex homes. It is copied one
 * way, from the machine the person works on to their seat on a host several
 * people use, so an agent there works as it does on their own machine. Logins,
 * settings, plugins, and transcripts are not part of it.
 */

import { z } from 'zod'
import { seatProviderSchema, type SeatProvider } from './seats'

/** What each provider home contributes, as the first segment of a profile path. */
export const AGENT_PROFILE_ENTRIES = {
  'claude-code': ['CLAUDE.md', 'skills', 'agents', 'commands'],
  codex: ['AGENTS.md', 'skills', 'prompts'],
} as const satisfies Record<SeatProvider, readonly string[]>

/** A file larger than this is left out and reported. */
export const AGENT_PROFILE_MAX_FILE_BYTES = 1024 * 1024
/** Files past this total are left out and reported. */
export const AGENT_PROFILE_MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_FILES = 5000

export const agentProfileFileSchema = z.object({
  provider: seatProviderSchema,
  /** Relative to the provider's home, `/`-separated: `skills/review/SKILL.md`. */
  path: z.string().min(1).max(512),
  contentBase64: z.string(),
  executable: z.boolean().optional(),
}).strict()
export type AgentProfileFile = z.infer<typeof agentProfileFileSchema>

export const agentProfileSkipSchema = z.object({
  provider: seatProviderSchema,
  path: z.string().max(512),
  /** `kept-on-host`: a host you own already has its own file there, which a copy never replaces. */
  reason: z.enum(['file-too-large', 'profile-too-large', 'unreadable', 'kept-on-host']),
}).strict()
export type AgentProfileSkip = z.infer<typeof agentProfileSkipSchema>

/** What `agentProfileRead` answers and `agentProfileApply` takes. An empty bundle removes the profile. */
export const agentProfileBundleSchema = z.object({
  files: z.array(agentProfileFileSchema).max(MAX_FILES),
  skipped: z.array(agentProfileSkipSchema).max(MAX_FILES),
}).strict()
export type AgentProfileBundle = z.infer<typeof agentProfileBundleSchema>

/** The caller's profile on a host: when it last arrived, and what it holds. */
export const agentProfileStatusSchema = z.object({
  /** Null when no profile was ever copied here, or it was removed. */
  syncedAt: z.number().nullable(),
  fileCount: z.number(),
  skipped: z.array(agentProfileSkipSchema),
})
export type AgentProfileStatus = z.infer<typeof agentProfileStatusSchema>
