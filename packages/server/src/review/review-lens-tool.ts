import { z } from 'zod'
import { REVIEW_LENS_MAX_HTML_CHARS } from '@solus/contracts/review'
import type { AgentTool } from '../agents/tools/agent-tool'

// ─── submit_review_lens: the lens agent's deliverable ───
//
// The arguments are the lens. No text scrape, and no `render_artifact`: a lens
// is review cache, not a work, until the user saves it as one.

export const SUBMIT_REVIEW_LENS_TOOL_NAME = 'submit_review_lens'

export interface LensDraft {
  title: string
  html: string
}

const fields = {
  title: z.string().describe('A short title for the lens, e.g. "Risk by file".'),
  html: z.string().describe(
    'The complete, self-contained HTML document. Inline all CSS and JavaScript. ' +
      'It runs with no network access: no external scripts, styles, fonts, images, or fetch calls.',
  ),
}

export type LensArgsResult = { ok: true; lens: LensDraft } | { ok: false; error: string }

/** The tool input is already parsed against `fields`; this checks what a schema
 * cannot say: an empty document, and the size limit. */
export function parseLensArgs(args: { title: string; html: string }): LensArgsResult {
  const title = args.title.trim()
  const html = args.html.trim()
  if (!html) return { ok: false, error: 'html is empty. Submit the complete HTML document.' }
  if (html.length > REVIEW_LENS_MAX_HTML_CHARS) {
    return { ok: false, error: `html is ${html.length} characters; the limit is ${REVIEW_LENS_MAX_HTML_CHARS}. Make it smaller and submit again.` }
  }
  return { ok: true, lens: { title: title || 'Lens', html } }
}

export function createReviewLensAgentTool(capture: (lens: LensDraft) => void): AgentTool {
  return {
    name: SUBMIT_REVIEW_LENS_TOOL_NAME,
    description: 'Submit the finished lens. Call exactly once with the complete HTML document.',
    inputFields: fields,
    requiresApproval: false,
    execute: async (args) => {
      const result = parseLensArgs(args)
      if (!result.ok) return { ok: false, text: result.error }
      capture(result.lens)
      return { ok: true, text: 'Captured the lens.' }
    },
  }
}
