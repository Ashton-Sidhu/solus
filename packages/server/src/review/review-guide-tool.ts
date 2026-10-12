import { z } from 'zod'
import type { GuideFileRef, GuideSection, GuideSignificance, ReviewGuideDraft } from '@solus/contracts/review'
import { parsePatch, renderFile, type ParsedFile, type ParsedHunk } from '../git/interdiff'
import { createLogger } from '../logger'
import type { AgentTool } from '../execution/agents/tools/agent-tool'

const log = createLogger('review', 'review-guide-tool.ts')

// ─── submit_review_guide: the agent's structured PR walkthrough ───
//
// Replaces the old `extractHtml()` text-scrape. The review agent calls this tool
// with the whole guide as its arguments — those args ARE the guide, captured
// directly (no markup, no parsing of free text).

const lineRangeSchema = z.object({
  side: z
    .enum(['old', 'new'])
    .describe("'new' for lines of the changed file (added or context lines); 'old' for lines that exist only in the base (deleted lines)."),
  start: z.number().int().min(1).describe('First line number on that side, as shown in the diff.'),
  end: z.number().int().min(1).describe('Last line number on that side, inclusive.'),
})

const fileReferenceSchema = z.object({
  path: z.string().describe('Repo-relative path EXACTLY as it appears in the diff (the b/ post-image path).'),
  ranges: z
    .array(lineRangeSchema)
    .describe(
      'The lines of THIS file that THIS concern is about. The host shows every diff hunk that a range ' +
        'touches, cut from the real patch with real line numbers. Use [] to show the whole file diff.',
    ),
})

const attentionSchema = z.object({
  kind: z
    .enum(['tradeoff', 'contract', 'product', 'risk', 'accessibility'])
    .describe(
      'tradeoff = a design choice with a real cost; contract = a changed API, schema, or protocol that ' +
        'other code or clients depend on; product = a user-visible behavior decision; risk = data, ' +
        'security, or migration exposure; accessibility = an effect on keyboard, screen reader, or contrast.',
    ),
  note: z.string().describe('One or two sentences: the decision the reviewer must make, and why it matters.'),
})

const sectionSchema = z.object({
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
      'The "why" for this concern, verified against the diff. ' +
        'Renders as Markdown: when listing more than one thing to verify, use a Markdown list ' +
        '(one `- ` or `1. ` item per line) rather than inline `(1) … (2) …` in a paragraph.',
    ),
  attention: attentionSchema
    .optional()
    .describe(
      'The one call a reviewer must make in this concern. Omit it on most sections. It is not a bug ' +
        'finding: do not hunt for bugs and do not invent concerns.',
    ),
  files: z.array(fileReferenceSchema).describe('Files this concern spans. A file may legitimately appear in more than one section.'),
})

export const submitReviewGuideFields = {
  title: z.string().describe('One-line title for the whole change.'),
  summary: z.string().describe('A 1–3 sentence overview: what the change does and why.'),
  sections: z
    .array(sectionSchema)
    .describe('The ordered walkthrough — core concerns first, supporting next, low-signal last.'),
}

const submitReviewGuideObject = z.object(submitReviewGuideFields)

export const SUBMIT_REVIEW_GUIDE_TOOL_NAME = 'submit_review_guide'

const SUBMIT_REVIEW_GUIDE_DESC = [
  'Submit the structured guided-review walkthrough for the change you just inspected.',
  'Call this EXACTLY ONCE, as your final action, with the whole guide as the arguments —',
  'these arguments ARE the guide, so there is no need to also write it as prose.',
  '',
  'Order sections the way a reviewer should read the PR: the core/entry-point concern first,',
  'then what depends on it, then mechanical/peripheral edits as low-signal. A concern may span',
  'several files, and the same file may appear in more than one concern.',
  '',
  "For each file in a concern, name the line ranges the concern is about in the file's `ranges`",
  'field. The host cuts the matching hunks from the real diff, so the reader sees only what',
  "matters, not the file's entire diff.",
  '',
  'Set `attention` only on a section where the reviewer must make a real decision. Most',
  'sections have none. Do not hunt for bugs and do not invent concerns.',
].join('\n')

/** The guide as the agent submits it: line ranges, not yet the stored hunks. */
export type SubmittedGuide = z.infer<typeof submitReviewGuideObject>

export interface ParseGuideResult {
  ok: boolean
  guide?: SubmittedGuide
  error?: string
}

/** Validate raw tool args into a draft. The Claude SDK pre-validates against the
 *  zod shape, but the Codex dynamicTools path hands us raw JSON, so we parse here
 *  for both. */
export function parseGuideArgs(args: Parameters<typeof submitReviewGuideObject.safeParse>[0]): ParseGuideResult {
  const parsed = submitReviewGuideObject.safeParse(args ?? {})
  if (!parsed.success) {
    return { ok: false, error: `submit_review_guide: invalid arguments — ${parsed.error.message}` }
  }
  return { ok: true, guide: parsed.data }
}

export function createReviewGuideAgentTool(
  capture: (guide: SubmittedGuide) => void,
): AgentTool {
  return {
    name: SUBMIT_REVIEW_GUIDE_TOOL_NAME,
    description: SUBMIT_REVIEW_GUIDE_DESC,
    inputFields: submitReviewGuideFields,
    requiresApproval: false,
    execute: async (args) => {
      const result = parseGuideArgs(args)
      if (!result.ok || !result.guide) {
        return { ok: false, text: result.error ?? 'invalid guide' }
      }
      capture(result.guide)
      return {
        ok: true,
        text: `Captured review guide with ${result.guide.sections.length} section(s).`,
      }
    },
  }
}

// ─── post-capture validation ───

export interface NormalizeGuideContext {
  /** The exact patch the guide reviews: the coverage target, and the only
   *  source of the hunks and line counts the guide stores. */
  patch: string
}

type LineRange = SubmittedGuide['sections'][number]['files'][number]['ranges'][number]

const BAND = { core: 0, supporting: 1, 'low-signal': 2 } satisfies Record<GuideSignificance, number>

/**
 * Turn a submitted guide into the stored guide, checked against the real
 * change, so the persisted guide always satisfies its invariants:
 *  - every file reference names a file of the patch; others are dropped;
 *  - a file's hunks and line counts come from the patch, never from the agent:
 *    the hunks are the ones its ranges touch, copied verbatim, so the line
 *    numbers are real and the text cannot drift from the change;
 *  - coverage — any changed file absent from every section is appended to a
 *    synthesized low-signal "Remaining changes" section, so an omission never
 *    silently reads as "fully reviewed";
 *  - sections sort into the core → supporting → low-signal bands, with
 *    `order` renumbered contiguously for a stable reading sequence.
 */
export function normalizeGuide(submitted: SubmittedGuide, ctx: NormalizeGuideContext): ReviewGuideDraft {
  const patchFiles = new Map(parsePatch(ctx.patch).map((file) => [file.filePath, file]))
  const sections: GuideSection[] = submitted.sections.map((section) => {
    const files = section.files.flatMap((ref) => {
      const file = patchFiles.get(ref.path)
      if (!file) {
        log.warn('guide_section_unknown_file_dropped', { sectionId: section.id })
        return []
      }
      return [fileReference(file, ref.ranges, section.id)]
    })
    const normalized: GuideSection = {
      id: section.id,
      title: section.title,
      order: section.order,
      significance: section.significance,
      explanation: section.explanation,
      files,
    }
    if (section.attention) normalized.attention = section.attention
    return normalized
  })

  const covered = new Set(sections.flatMap((s) => s.files.map((f) => f.path)))
  const missing = [...patchFiles.values()].filter((file) => !covered.has(file.filePath))
  if (missing.length > 0) {
    log.warn('guide_omitted_changed_files', { count: missing.length })
    sections.push({
      id: 'remaining-changes',
      title: 'Remaining changes',
      order: sections.length,
      significance: 'low-signal',
      explanation:
        'Files changed on this branch that the guide did not place into a concern. Skim them for anything unexpected.',
      files: missing.map((file) => fileReference(file, [], 'remaining-changes')),
    })
  }

  sections.sort((a, b) => BAND[a.significance] - BAND[b.significance] || a.order - b.order)
  sections.forEach((s, i) => {
    s.order = i
  })

  return { title: submitted.title, summary: submitted.summary, sections }
}

function fileReference(file: ParsedFile, ranges: LineRange[], sectionId: string): GuideFileRef {
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.body) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  const touched = file.hunks.filter((hunk) => ranges.some((range) => touches(hunk, range)))
  if (ranges.length > 0 && touched.length === 0) {
    log.warn('guide_file_ranges_outside_diff', { sectionId })
  }
  // A whole file is shown when no range lands on a hunk.
  return touched.length > 0 && touched.length < file.hunks.length
    ? { path: file.filePath, additions, deletions, hunks: renderFile(file, file.filePath, touched) }
    : { path: file.filePath, additions, deletions }
}

/** Whether a line range overlaps the lines a hunk covers on that side. A hunk
 *  with no lines on a side (a pure addition or deletion) sits at its start. */
function touches(hunk: ParsedHunk, range: LineRange): boolean {
  const start = range.side === 'new' ? hunk.newStart : hunk.oldStart
  const count = range.side === 'new' ? hunk.newLines : hunk.oldLines
  const end = start + Math.max(count, 1) - 1
  return range.start <= end && Math.max(range.start, range.end) >= start
}
