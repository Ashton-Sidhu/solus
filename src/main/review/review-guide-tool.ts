import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { GuideSignificance, ReviewGuideDraft } from '../../shared/review'
import { createLogger } from '../logger'

const log = createLogger('review', 'review-guide-tool.ts')

// ─── submit_review_guide: the agent's structured PR walkthrough ───
//
// Replaces the old `extractHtml()` text-scrape. The review agent calls this tool
// with the whole guide as its arguments — those args ARE the guide, captured
// directly (no markup, no parsing of free text). Registered two ways: as an
// in-process MCP tool for Claude and a dynamicTools JSON-schema descriptor for
// the Codex one-shot.

const fileRefShape = z.object({
  path: z.string().describe('Repo-relative path EXACTLY as it appears in the diff (the b/ post-image path).'),
  additions: z.number().int().min(0).describe('Lines added to this file in the change.'),
  deletions: z.number().int().min(0).describe('Lines removed from this file in the change.'),
  hunks: z
    .string()
    .describe(
      'The unified-diff hunks for THIS file that are relevant to THIS concern — a valid single-file ' +
        'patch: the `diff --git`/`---`/`+++` header lines for the file followed by only the `@@ … @@` ' +
        'hunks that matter to this concern. Copy them VERBATIM from `git diff` output; keep each hunk ' +
        'whole (never edit or trim lines inside a hunk, or the diff will render wrong). Include only the ' +
        "hunks the concern is about, not the file's entire diff, and omit the rest.",
    ),
})

const sectionShape = z.object({
  id: z.string().describe('Stable slug for this concern, e.g. "receipt-localization".'),
  title: z.string().describe('Short human title for the concern, e.g. "Receipt Localization".'),
  order: z
    .number()
    .int()
    .describe('Reading order (0-based) within its significance band — core/entry-point concern first.'),
  significance: z
    .enum(['core', 'supporting', 'low-signal'])
    .describe(
      'core = essential to understand the change; supporting = depends on the core; low-signal = mechanical/peripheral (renames, formatting), collapsed by default.',
    ),
  explanation: z
    .string()
    .describe(
      'The "why" for this concern — woven from the ledger when present, verified against the diff. ' +
        'Renders as Markdown: when listing more than one thing to verify, use a Markdown list ' +
        '(one `- ` or `1. ` item per line) rather than inline `(1) … (2) …` in a paragraph.',
    ),
  ledgerRefs: z
    .array(z.string())
    .describe('Ledger record ids that inform this section. Use [] when no ledger is present or none apply.'),
  files: z.array(fileRefShape).describe('Files this concern spans. A file may legitimately appear in more than one section.'),
})

export const submitReviewGuideShape = {
  title: z.string().describe('One-line title for the whole change.'),
  summary: z.string().describe('A 1–3 sentence overview: what the change does and why.'),
  sections: z
    .array(sectionShape)
    .describe('The ordered walkthrough — core concerns first, supporting next, low-signal last.'),
}

const submitReviewGuideObject = z.object(submitReviewGuideShape)

export const SUBMIT_REVIEW_GUIDE_TOOL_NAME = 'submit_review_guide'
export const SUBMIT_REVIEW_GUIDE_MCP_TOOL = `mcp__solus__${SUBMIT_REVIEW_GUIDE_TOOL_NAME}`

const SUBMIT_REVIEW_GUIDE_DESC = [
  'Submit the structured guided-review walkthrough for the change you just inspected.',
  'Call this EXACTLY ONCE, as your final action, with the whole guide as the arguments —',
  'these arguments ARE the guide, so there is no need to also write it as prose.',
  '',
  'Order sections the way a reviewer should read the PR: the core/entry-point concern first,',
  'then what depends on it, then mechanical/peripheral edits as low-signal. A concern may span',
  'several files, and the same file may appear in more than one concern.',
  '',
  "For each file in a concern, embed the relevant diff hunks in the file's `hunks` field —",
  'copied verbatim from `git diff`, trimmed to just the hunks that concern is about — so the',
  "reader sees only what matters, not the file's entire diff.",
].join('\n')

export interface ParseGuideResult {
  ok: boolean
  guide?: ReviewGuideDraft
  error?: string
}

/** Validate raw tool args into a draft. The Claude SDK pre-validates against the
 *  zod shape, but the Codex dynamicTools path hands us raw JSON, so we parse here
 *  for both. */
export function parseGuideArgs(args: unknown): ParseGuideResult {
  const parsed = submitReviewGuideObject.safeParse(args ?? {})
  if (!parsed.success) {
    return { ok: false, error: `submit_review_guide: invalid arguments — ${parsed.error.message}` }
  }
  return { ok: true, guide: parsed.data }
}

const codexCaptures = new Map<string, (guide: ReviewGuideDraft) => void>()

export function registerCodexReviewGuideCapture(threadId: string, capture: (guide: ReviewGuideDraft) => void): () => void {
  codexCaptures.set(threadId, capture)
  return () => {
    if (codexCaptures.get(threadId) === capture) codexCaptures.delete(threadId)
  }
}

export function executeCodexReviewGuideTool(threadId: string, args: unknown): { ok: boolean; text: string } {
  const capture = codexCaptures.get(threadId)
  if (!capture) return { ok: false, text: `No review guide capture is registered for Codex thread ${threadId}.` }

  const result = parseGuideArgs(args)
  if (!result.ok || !result.guide) return { ok: false, text: result.error ?? 'invalid guide' }

  capture(result.guide)
  return { ok: true, text: `Captured review guide with ${result.guide.sections.length} section(s).` }
}

/** Shape 1: the Claude SDK in-process MCP server hosting just this tool. The
 *  executor captures the validated draft into `capture` and acks; the producer
 *  reads it back after the run completes. */
export function reviewGuideMcpServer(capture: (guide: ReviewGuideDraft) => void) {
  return createSdkMcpServer({
    name: 'solus',
    version: '1.0.0',
    tools: [
      tool(SUBMIT_REVIEW_GUIDE_TOOL_NAME, SUBMIT_REVIEW_GUIDE_DESC, submitReviewGuideShape, async (args) => {
        const result = parseGuideArgs(args)
        if (!result.ok || !result.guide) {
          return { content: [{ type: 'text' as const, text: result.error ?? 'invalid guide' }], isError: true as const }
        }
        capture(result.guide)
        return {
          content: [{ type: 'text' as const, text: `Captured review guide with ${result.guide.sections.length} section(s).` }],
        }
      }),
    ],
  })
}

/** Shape 2: the Codex dynamicTools JSON-schema descriptor (same shape as Claude). */
export const SUBMIT_REVIEW_GUIDE_TOOL_JSON_SCHEMA = {
  name: SUBMIT_REVIEW_GUIDE_TOOL_NAME,
  description: SUBMIT_REVIEW_GUIDE_DESC,
  inputSchema: z.toJSONSchema(submitReviewGuideObject) as Record<string, unknown>,
}

// ─── post-capture validation ───

export interface NormalizeGuideContext {
  /** Every file in the diff (post-image paths) — the coverage target. */
  changedFiles: string[]
  /** Known ledger record ids — anything else a section cites is a hallucination. */
  ledgerIds: string[]
}

const BAND: Record<GuideSignificance, number> = { core: 0, supporting: 1, 'low-signal': 2 }

/**
 * Validate + normalize a captured draft against the real change so the persisted
 * guide always satisfies its invariants:
 *  - drop `ledgerRefs` that don't match a known record (hallucination guard);
 *  - guarantee coverage — any changed file absent from every section is appended
 *    to a synthesized low-signal "Remaining changes" section, so an omission
 *    never silently reads as "fully reviewed";
 *  - sort sections into the core → supporting → low-signal bands and re-number
 *    `order` contiguously for a stable reading sequence.
 */
export function normalizeGuide(draft: ReviewGuideDraft, ctx: NormalizeGuideContext): ReviewGuideDraft {
  const ledgerSet = new Set(ctx.ledgerIds)
  const sections = draft.sections.map((s) => {
    const refs = s.ledgerRefs.filter((r) => ledgerSet.has(r))
    const dropped = s.ledgerRefs.length - refs.length
    if (dropped > 0) log.warn(`section "${s.id}" cited ${dropped} unknown ledger id(s) — dropped`)
    return { ...s, ledgerRefs: refs }
  })

  const covered = new Set(sections.flatMap((s) => s.files.map((f) => f.path)))
  const missing = ctx.changedFiles.filter((f) => !covered.has(f))
  if (missing.length > 0) {
    log.warn(`guide omitted ${missing.length} changed file(s) — appending a low-signal catch-all`)
    sections.push({
      id: 'remaining-changes',
      title: 'Remaining changes',
      order: sections.length,
      significance: 'low-signal',
      explanation:
        'Files changed on this branch that the guide did not place into a concern. Skim them for anything unexpected.',
      ledgerRefs: [],
      files: missing.map((path) => ({ path, additions: 0, deletions: 0 })),
    })
  }

  sections.sort((a, b) => BAND[a.significance] - BAND[b.significance] || a.order - b.order)
  sections.forEach((s, i) => {
    s.order = i
  })

  return { ...draft, sections }
}
