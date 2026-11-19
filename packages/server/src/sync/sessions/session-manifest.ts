import { z } from 'zod'
import { sessionStarterSchema } from '@solus/contracts/session-starter'

/**
 * `manifest.json` of a session repository (docs/plans/portable-sessions.md §5.1).
 * Each turn commit rewrites it. A host that syncs a session reads only this
 * file to learn which other files to read.
 */

const turnSnapshotSchema = z.object({
  index: z.number(),
  fromTreeSha: z.string(),
  toTreeSha: z.string(),
  sha: z.string(),
  timestamp: z.number(),
  partial: z.boolean(),
  userMessagePreview: z.string(),
  traceId: z.string().optional(),
  filesChanged: z.number(),
  additions: z.number(),
  deletions: z.number(),
})

/** One provider file of a thread. Turn `n` of `parts` added the bytes at `threads/<threadId>/<key>/<n>`. */
const threadFileSchema = z.object({
  key: z.string(),
  /** Where the file is under the provider's own folder for the thread. */
  relativePath: z.string(),
  length: z.number(),
  parts: z.array(z.number()),
})

const threadSchema = z.object({
  threadId: z.string(),
  provider: z.string(),
  /** Missing in phase-1 commits. */
  startedAs: z.enum(['start', 'fork', 'handoff']).optional(),
  files: z.array(threadFileSchema),
})

const codeBundleSchema = z.discriminatedUnion('kind', [
  /** `code/<n>.bundle` holds these refs. */
  z.object({ kind: z.literal('written'), refs: z.record(z.string(), z.string()), bytes: z.number() }),
  /** Origin and the earlier bundles hold every object of the turn. */
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('too-large'), bytes: z.number() }),
  /** Git could not write the bundle; the code state of this turn is not in the repository. */
  z.object({ kind: z.literal('failed') }),
])

const turnSchema = z.object({
  operationId: z.string(),
  endedAt: z.number(),
  provider: z.string(),
  threadId: z.string(),
  partial: z.boolean(),
  /** The branch and its tip when the turn ended; null for a session with no checkout. */
  head: z.object({ sha: z.string().nullable(), branch: z.string().nullable() }).nullable(),
  /** The snapshots of the session that this turn commit covers. */
  snapshots: z.array(turnSnapshotSchema),
  bundle: codeBundleSchema.nullable(),
  /** True when `diff/<n>.patch` exists. */
  hasDiff: z.boolean(),
})

export const sessionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  session: z.object({
    id: z.string(), organizationId: z.string(),
    title: z.string().nullable().optional(), model: z.string().nullable().optional(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).nullable().optional(),
    permissionMode: z.enum(['supervised', 'accept-edits', 'auto', 'full-access', 'plan']).nullable().optional(),
    startedBy: sessionStarterSchema.nullable().optional(), parentSessionId: z.string().nullable().optional(),
    rootSessionId: z.string().nullable().optional(),
  }),
  threads: z.array(threadSchema),
  /** Absent in phase-1 commits. */
  lineage: z.array(z.object({ threadId: z.string(), provider: z.string(), startedAs: z.enum(['start', 'fork', 'handoff']) })).optional(),
  sessionPaths: z.object({ turnPaths: z.array(z.string()), sessionChangedFiles: z.array(z.string()) }).optional(),
  lastProjectRoot: z.string().nullable().optional(),
  project: z.object({
    repositoryKey: z.string().nullable(),
    baseSha: z.string(),
    /** False for a session that ran in a checkout that other authors also edit. */
    ownsWorktree: z.boolean(),
  }).nullable(),
  turns: z.array(turnSchema),
})

export type SessionManifest = z.infer<typeof sessionManifestSchema>
export type SessionManifestTurn = z.infer<typeof turnSchema>
export type SessionManifestThreadFile = z.infer<typeof threadFileSchema>

export function emptySessionManifest(sessionId: string, organizationId: string): SessionManifest {
  return { schemaVersion: 1, session: { id: sessionId, organizationId }, threads: [], project: null, turns: [] }
}
