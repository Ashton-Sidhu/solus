import { z } from 'zod'

export const claudeAutoRestrictionSchema = z.enum(['managed-settings', 'user-settings', 'project-settings'])
export type ClaudeAutoRestriction = z.infer<typeof claudeAutoRestrictionSchema>

export interface ClaudeAutoModeTarget {
  /** The checkout on the run host, when it already exists. */
  cwd?: string
  sessionId?: string
}

export const CLAUDE_AUTO_RESTRICTION_TEXT = {
  'managed-settings': "Your organization's Claude settings turn off Auto.",
  'user-settings': 'Your Claude settings turn off Auto.',
  'project-settings': "This project's Claude settings turn off Auto.",
} satisfies Record<ClaudeAutoRestriction, string>

export function claudeAutoFallbackText(restriction: ClaudeAutoRestriction | null): string {
  const reason = restriction ? CLAUDE_AUTO_RESTRICTION_TEXT[restriction] : 'Claude reported that Auto is unavailable.'
  return `Claude is asking for approval. ${reason} You can switch to Supervised or Auto-accept edits.`
}
