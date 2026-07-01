import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { ReviewLedger } from '../../shared/review'
import { createLogger } from '../logger'
import { readLedgerByKey, resolveReviewContext, writeLedger } from './ledger'

const log = createLogger('review', 'ledger-tool.ts')

// ─── record_change: the agent's "commit of cognition" ───
//
// Separate from the git commit. After the agent finishes editing code for a
// turn it appends/amends one record per semantic change to the branch ledger,
// so the review companion (and any later session) reads intent/risk/uncertainty
// instead of re-deriving them from a flattened diff. The system prompt makes
// this a mandatory call before the agent yields when it has changed code.

const changeShape = z.object({
  id: z
    .string()
    .describe(
      'A stable semantic key for this change, reused across turns when you revise it (e.g. "rate-limit-key", "session-base-sha"). Amending an existing id appends history instead of duplicating.',
    ),
  title: z.string().describe('A short human-readable title for the change.'),
  intent: z.string().describe('Why this change was made — the goal or purpose it serves.'),
  why: z.string().describe('Why this approach was chosen — the rationale behind the implementation decision.'),
  assumptions: z.string().optional().describe('Assumptions made when implementing this change.'),
  alternatives: z.string().optional().describe('Alternative solutions that were considered and why they were not chosen.'),
  edgeCases: z.string().optional().describe('Edge cases considered during implementation.'),
  question: z.string().optional().describe('An explicit question for the human, if any.'),
  file: z.string().optional().describe('Repo-relative file the change lives in (omit for a pure omission).'),
  line: z.number().int().optional().describe('Anchor line in that file (1-based).'),
  missing: z.boolean().optional().describe('true when this records an expected change you did NOT make.'),
  supersedes: z
    .string()
    .optional()
    .describe('The id of a prior record this change reverses or replaces, if any.'),
})

export const recordChangeShape = {
  summary: z
    .string()
    .describe('A one-paragraph check-out note for this session: what you changed overall and why.'),
  changes: z
    .array(changeShape)
    .describe('One entry per semantic change you made this turn. Use [] only if you changed no code.'),
}

const recordChangeObject = z.object(recordChangeShape)

export const RECORD_CHANGE_TOOL_NAME = 'record_change'

export interface RecordChangeCtx {
  cwd: string
  sessionId: () => string | undefined
  now: () => string
}

type ChangeInput = z.infer<typeof changeShape>

function upsertRecord(ledger: ReviewLedger, sessionId: string, now: string, c: ChangeInput): void {
  const existing = ledger.records.find((r) => r.id === c.id)
  const anchor = c.file ? { file: c.file, line: c.line ?? 0 } : undefined
  if (existing) {
    existing.title = c.title
    existing.intent = c.intent
    existing.why = c.why
    existing.sessionId = sessionId
    if (c.assumptions !== undefined) existing.assumptions = c.assumptions
    if (c.alternatives !== undefined) existing.alternatives = c.alternatives
    if (c.edgeCases !== undefined) existing.edgeCases = c.edgeCases
    if (c.question !== undefined) existing.question = c.question
    if (anchor) existing.anchor = anchor
    if (c.missing !== undefined) existing.missing = c.missing
    if (c.supersedes !== undefined) existing.supersedes = c.supersedes
    existing.history.push({ sessionId, at: now, note: c.why })
    return
  }
  ledger.records.push({
    id: c.id,
    title: c.title,
    sessionId,
    intent: c.intent,
    why: c.why,
    ...(c.assumptions !== undefined ? { assumptions: c.assumptions } : {}),
    ...(c.alternatives !== undefined ? { alternatives: c.alternatives } : {}),
    ...(c.edgeCases !== undefined ? { edgeCases: c.edgeCases } : {}),
    ...(c.question !== undefined ? { question: c.question } : {}),
    ...(anchor ? { anchor } : {}),
    ...(c.supersedes !== undefined ? { supersedes: c.supersedes } : {}),
    ...(c.missing !== undefined ? { missing: c.missing } : {}),
    history: [{ sessionId, at: now, note: 'created' }],
  })
}

function upsertSession(ledger: ReviewLedger, sessionId: string, now: string, summary: string): void {
  const existing = ledger.sessions.find((s) => s.id === sessionId)
  if (existing) {
    existing.endedAt = now
    existing.summary = summary
    return
  }
  ledger.sessions.push({ id: sessionId, startedAt: now, endedAt: now, summary })
}

export interface RecordChangeResult {
  ok: boolean
  text: string
}

export async function recordChange(args: unknown, rc: RecordChangeCtx): Promise<RecordChangeResult> {
  // Self-validate: the claude SDK path pre-validates against the schema, but the
  // codex dynamicTools path hands us raw JSON, so parse here for both.
  const parsed = recordChangeObject.safeParse(args ?? {})
  if (!parsed.success) {
    return { ok: false, text: `record_change: invalid arguments — ${parsed.error.message}` }
  }
  const { summary, changes } = parsed.data
  try {
    const review = await resolveReviewContext(rc.cwd, rc.sessionId())
    if (!review) {
      // Not in a git repo (or no branch) — nothing to anchor a ledger to. Report
      // success so a non-repo session isn't blocked by a mandatory ritual.
      return { ok: true, text: 'No git branch detected — skipped the review ledger for this session.' }
    }

    const now = rc.now()
    const sessionId = rc.sessionId() ?? review.key
    const ledger =
      (await readLedgerByKey(review.repoRoot, review.key)) ??
      {
        version: 1,
        key: review.key,
        base: { branch: review.targetBranch, sha: review.baseSha },
        sessions: [],
        records: [],
        createdAt: now,
        updatedAt: now,
      }

    upsertSession(ledger, sessionId, now, summary)
    for (const c of changes) upsertRecord(ledger, sessionId, now, c)
    ledger.updatedAt = now

    const ok = await writeLedger(review.repoRoot, ledger)
    if (!ok) return { ok: false, text: 'Failed to write the review ledger.' }
    const n = changes.length
    return {
      ok: true,
      text: `Recorded ${n} change${n === 1 ? '' : 's'} to the review ledger for "${review.key}".`,
    }
  } catch (err: any) {
    log.error(`recordChange failed: ${String(err)}`)
    return { ok: false, text: `record_change error: ${String(err?.message ?? err)}` }
  }
}

const RECORD_CHANGE_DESC = [
  'Append your reasoning about the code you just changed to the branch review ledger — the durable',
  'context the Solus review companion is built from. This is a "commit of cognition", separate from the',
  'git commit: it captures intent, risk, uncertainty, and omissions that a raw diff erases.',
  '',
  'Call this once, as your LAST action, after you finish editing code in a turn. Reuse a stable `id`',
  'across turns to amend a change rather than duplicate it. If you changed no code, you do not need to call it.',
].join('\n')

/** Shape 1: the claude SDK MCP tool wrapper, hosted on the in-process "solus" server. */
export function reviewLedgerTool(rc: RecordChangeCtx) {
  return tool(RECORD_CHANGE_TOOL_NAME, RECORD_CHANGE_DESC, recordChangeShape, async (args) => {
    const result = await recordChange(args, rc)
    return {
      content: [{ type: 'text' as const, text: result.text }],
      ...(result.ok ? {} : { isError: true as const }),
    }
  })
}

/** Shape 2: codex dynamicTools JSON-schema descriptor (same executor as claude). */
export const RECORD_CHANGE_TOOL_JSON_SCHEMA = {
  name: RECORD_CHANGE_TOOL_NAME,
  description: RECORD_CHANGE_DESC,
  inputSchema: z.toJSONSchema(recordChangeObject) as Record<string, unknown>,
}
