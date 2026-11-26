import { z } from 'zod'

/** A folder the person used with Claude Code or Codex on this host (docs/plans/one-page-onboarding.md §3.2). */
export const agentHistoryProjectSchema = z.object({
  /** Absolute, as the host sees it. */
  path: z.string().min(1),
  /** The folder's basename. */
  name: z.string(),
  sources: z.array(z.enum(['claude-code', 'codex'])),
  threadCount: z.number().int().nonnegative(),
  /** ms since epoch. */
  lastUsedAt: z.number().int(),
  /** The folder is still on disk. */
  exists: z.boolean(),
  /** Already a Solus project on this host. */
  isProject: z.boolean(),
})
export type AgentHistoryProject = z.infer<typeof agentHistoryProjectSchema>
