import { createLogger } from '../logger'
import type { ReviewContext, ReviewLedger, ReviewGuideDraft } from '../../shared/review'
import type { AgentId, ReasoningEffort } from '../../shared/types'
import type { ReviewProgressStep } from '../../shared/review'
import type { AgentDispatcher } from '../agents/agent-runner'
import { buildSystemPrompt } from '../agents/system-hint'
import {
  createReviewGuideAgentTool,
} from './review-guide-tool'

const log = createLogger('review', 'review-agent.ts')

export interface ReviewAgentInput {
  /** Directory the agent runs git in — the worktree holding the live edits. */
  workTree: string
  /** Resolved diff base (the episode base SHA, or 'HEAD' when unresolved). */
  base: string
  ledger: ReviewLedger | null
  context: ReviewContext
  agent: AgentId
  model?: string | null
  /** Reasoning effort for the review run; falls back to 'high' when unset.
   *  Callers resolve this from settings (default medium, see resolveReviewAgent). */
  reasoningEffort?: ReasoningEffort | null
  /** Pre-computed diff to inline into the prompt so the agent skips gathering it
   *  with git. Null/undefined ⇒ the agent gathers the diff itself (large-diff path). */
  inlineDiff?: string | null
  /** Phase callback so the producer can stream progress to the UI. */
  onProgress?: (step: ReviewProgressStep) => void
  abortSignal?: AbortSignal
}

/**
 * Run the review agent and return the structured guide it authored. The agent
 * gathers the diff ITSELF with git (the prompt tells it how), so the change never
 * bloats the prompt; the ledger, when present, is the only context handed inline.
 *
 * The guide arrives as the arguments of a `submit_review_guide` tool call, so
 * there is no text-scrape. Returns null when the agent never produced a usable
 * guide, so the producer can fall back.
 */
export async function runReviewAgent(
  dispatcher: AgentDispatcher,
  input: ReviewAgentInput,
): Promise<ReviewGuideDraft | null> {
  const ledgerPresent = !!input.ledger && input.ledger.records.length > 0
  const prompt = buildPrompt(input, ledgerPresent)
  // Effort is settings-driven (resolveReviewAgent defaults it to medium); 'high'
  // is only a safety fallback for callers that don't resolve one.
  const reasoningEffort = input.reasoningEffort ?? 'high'

  let captured: ReviewGuideDraft | null = null
  const submitGuideTool = createReviewGuideAgentTool((guide) => {
    input.onProgress?.('writing')
    captured = guide
  })
  try {
    const run = dispatcher.runAgent({
      provider: input.agent,
      prompt,
      cwd: input.workTree,
      tools: [submitGuideTool],
      model: input.model,
      reasoningEffort,
      permissionMode: 'plan',
      persistence: 'ephemeral',
      systemPrompt: buildSystemPrompt({
        agent: input.agent === 'codex' ? 'codex' : 'claude',
        general: false,
        planMode: true,
      }),
    })
    const cancel = () => run.cancel()
    if (input.abortSignal?.aborted) cancel()
    else input.abortSignal?.addEventListener('abort', cancel, { once: true })
    try {
      await run.done
    } finally {
      input.abortSignal?.removeEventListener('abort', cancel)
    }
  } catch (err) {
    // Don't return here: a late stream error (budget cut, transport hiccup)
    // must not discard a guide the agent already submitted.
    log.error('review_agent_run_failed', { agent: input.agent, error: String(err) })
  }

  if (!captured) {
    log.warn('review_agent_no_usable_guide', { agent: input.agent })
    return null
  }
  return captured
}

// ─── prompt ───

function buildPrompt(input: ReviewAgentInput, ledgerPresent: boolean): string {
  const parts: string[] = []

  parts.push(
    'Use the pr-review-guide skill.',
    '',
    // 'You are reviewing an agent-authored code change and producing a GUIDED REVIEW for Solus.',
    // 'The skill defines the review workflow, concern ordering, ledger usage, and submit_review_guide output contract.',
    // '',
    // `Branch: ${context.branch} (target: ${context.targetBranch}, base ${context.baseSha.slice(0, 8)})`,
    // `Reviewer: ${reviewer}`,
    // '',
    // 'INSPECT THE CHANGE YOURSELF — do this before composing the guide. The diff is NOT inlined below;',
    // 'gather it with your tools so you can read it at the right altitude:',
    // `  • The change is everything between base commit ${input.base} and the current working tree.`,
    // `    Your working directory (${input.workTree}) is that worktree.`,
    // `  • Start with \`git diff ${input.base} --stat\` for the file list, then \`git diff ${input.base}\``,
    // '    (scope to a file with `-- <path>`) to read the hunks.',
    // '  • New files in this change are untracked and will NOT appear in `git diff`. List them with',
    // '    `git ls-files --others --exclude-standard` and Read each in full — they are part of the change.',
    // '  • Use Read/Grep/Glob to inspect surrounding code for the context a hunk needs.',
    // '  • You are strictly read-only: only read-only git commands and file reads are permitted.',
    // '  • Account for EVERY changed file: each one must appear in at least one concern (place purely',
    // '    mechanical files in a low-signal concern). For each file record its path exactly as it appears',
    // '    in the diff plus its added/removed line counts.',
    // '  • Follow the pr-review-guide skill when deciding section boundaries and significance.',
    '',
  )

  if (input.inlineDiff) {
    parts.push(
      'The COMPLETE diff for this change is provided at the end of this message — do NOT gather it',
      'with git; review it directly. It already includes new/untracked files (as additions with full',
      `content) and everything between base ${input.base} and the current working tree. If a hunk needs`,
      'surrounding context, use Read/Grep on the working tree; otherwise you need no git commands.',
      '',
    )
  }

  if (ledgerPresent && input.ledger) {
    parts.push(
      'A review ledger is available — the authoring sessions recorded, per change, what changed (title),',
      'why we made it (intent), why it was done this way (why), assumptions, alternatives, and edge cases.',
      'Use these as the primary source for each concern\'s explanation; verify them against the diff and',
      'fill any gaps the ledger leaves.',
      '',
      'Ledger records (JSON):',
      JSON.stringify(input.ledger.records, null, 2),
      '',
    )
  }

  // parts.push(
  //   `When you are done, call the \`${SUBMIT_REVIEW_GUIDE_TOOL_NAME}\` tool EXACTLY ONCE with the whole`,
  //   'guide as its arguments — title, summary, and the ordered sections. The tool arguments ARE the',
  //   'deliverable; do not also write the guide as prose. Do not call the tool until you have inspected',
  //   'the full change.',
  // )

  if (input.inlineDiff) {
    parts.push(
      `Diff (\`git diff ${input.base}\`):`,
      '```diff',
      input.inlineDiff,
      '```',
      '',
    )
  }

  return parts.join('\n')
}
