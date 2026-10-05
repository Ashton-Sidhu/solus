import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PromptOptions, SessionRunInput } from '@solus/contracts/types'
import { queueAttachmentSchema } from '@solus/contracts/session-queue'
import { userSchema } from '@solus/contracts/user'

const inputFields = z.object({
  provider: z.enum(['claude-code', 'codex', 'opencode']), agentSessionId: z.string().nullable(),
  workingDirectory: z.string(), projectPath: z.string(), model: z.string(), preferredModel: z.string().nullable(),
  forked: z.boolean(), additionalDirs: z.array(z.string()), sessionChangedFiles: z.array(z.string()),
  contextWindow: z.number().nullable(), fastMode: z.boolean(), extraInstructions: z.string(),
  permissionMode: z.enum(['supervised', 'accept-edits', 'auto', 'full-access', 'plan']),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']),
  rateLimitBehavior: z.enum(['ask', 'queue', 'continue', 'stop']), worktreeBaseBranch: z.string().nullable(),
})
const optionFields = z.object({
  prompt: z.string(), displayPrompt: z.string().optional(), clientPromptId: z.string().optional(),
  imageAttachments: z.array(z.object({ mimeType: z.string(), dataUrl: z.string() })).optional(),
  imageAttachmentRefs: z.array(z.object({ mimeType: z.string(), hostPath: z.string(), name: z.string().optional() })).optional(),
  queueAttachments: z.array(queueAttachmentSchema).optional(),
})

/** The host wrote these run payloads after admission. Validate the execution
 * fields without stripping task packets or other optional provider context. */
export const savedRunInputSchema = z.custom<SessionRunInput>((value) => inputFields.safeParse(value).success)
const savedOptions = z.custom<PromptOptions>((value) => optionFields.safeParse(value).success)
export const savedQueueEntrySchema = z.object({
  queueId: z.string(), sessionId: z.string(), prompt: z.string(), enqueuedAt: z.number(),
  reason: z.enum(['busy', 'rate_limit']), revision: z.number().int().nonnegative(),
  kind: z.enum(['prompt', 'provider_switch']), held: z.boolean(), error: z.string().optional(),
  input: savedRunInputSchema, requestedInput: savedRunInputSchema.optional(), options: savedOptions, author: userSchema.optional(),
  sourceSessionId: z.string().optional(), rateLimitSessionId: z.string().optional(),
  releaseAt: z.number().optional(), rateLimitType: z.string().optional(), runId: z.string().optional(),
  exchangeIds: z.array(z.string()).optional(),
  reportExchangeIds: z.array(z.string()).optional(),
  started: z.boolean().optional(),
})
export type SavedQueueEntry = z.infer<typeof savedQueueEntrySchema>
const savedQueueSchema = z.object({ version: z.literal(1), entries: z.array(savedQueueEntrySchema) })

/** Host-local execution state. Atomic replacement never leaves a partial JSON
 * file after a crash. Credentials, tools, callbacks, and grants are not saved. */
export class SessionQueueStore {
  constructor(private readonly directory: string) {}

  load(): SavedQueueEntry[] {
    let names: string[]
    try { names = readdirSync(this.directory) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    return names.filter((name) => name.endsWith('.json')).flatMap((name) =>
      savedQueueSchema.parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8'))).entries,
    )
  }

  save(sessionId: string, entries: SavedQueueEntry[]): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
    if (!entries.length) { rmSync(file, { force: true }); return }
    const pending = `${file}.pending`
    writeFileSync(pending, JSON.stringify({ version: 1, entries }), { mode: 0o600 })
    renameSync(pending, file)
  }
}
