import type { ReviewLedger } from '@solus/contracts/review'
import type { AgentId, ReasoningEffort } from '@solus/contracts/types'
import type { AgentDispatcher } from '../agents/agent-runner'
import { buildSystemPrompt } from '../agents/system-hint'
import { hostInstructionsFor } from '../agents/run-input'
import { createLogger } from '../logger'
import { SPAN_SERVICES } from '../observability/registries'
import { createReviewLensAgentTool, SUBMIT_REVIEW_LENS_TOOL_NAME, type LensDraft } from './review-lens-tool'

const log = createLogger('review', 'lens-agent.ts')
const LENS_AGENT_TIMEOUT_MS = 10 * 60_000

export interface LensEditInput {
  /** The lens as it is now. */
  html: string
  prompt: string
  comments: { label: string; body: string; quote?: string; codeAnchor?: { path: string; line: number } }[]
}

export interface LensAgentInput {
  workTree: string
  base: string
  head: string | null
  /** The diff, when it is small enough to put in the prompt. */
  inlineDiff: string | null
  ledger: ReviewLedger | null
  /** The lens prompt: from a saved lens, a one-time prompt, or the lens being edited. */
  prompt: string
  /** Present for a lens edit. */
  edit?: LensEditInput
  agent: AgentId
  model: string | null
  reasoningEffort: ReasoningEffort | null
  onWriting: () => void
  abortSignal: AbortSignal
}

/** Run the lens agent and return the lens it submitted, or null. */
export async function runLensAgent(dispatcher: AgentDispatcher, input: LensAgentInput): Promise<LensDraft | null> {
  let captured: LensDraft | null = null
  const tool = createReviewLensAgentTool((lens) => {
    input.onWriting()
    captured = lens
  })
  try {
    const run = dispatcher.runAgent({
      provider: input.agent,
      prompt: buildLensPrompt(input),
      cwd: input.workTree,
      tools: [tool],
      model: input.model,
      reasoningEffort: input.reasoningEffort ?? 'medium',
      permissionMode: 'plan',
      persistence: 'ephemeral',
      service: SPAN_SERVICES.reviewLens,
      unattended: true,
      timeoutMs: LENS_AGENT_TIMEOUT_MS,
      systemPrompt: buildSystemPrompt(hostInstructionsFor(input.model)) || undefined,
    })
    const cancel = () => run.cancel()
    if (input.abortSignal.aborted) cancel()
    else input.abortSignal.addEventListener('abort', cancel, { once: true })
    try {
      await run.done
    } finally {
      input.abortSignal.removeEventListener('abort', cancel)
    }
  } catch (error) {
    // A late stream error must not discard a lens the agent already submitted.
    log.error('lens_agent_run_failed', { agent: input.agent, error: String(error) })
  }
  if (!captured) log.warn('lens_agent_no_lens', { agent: input.agent })
  return captured
}

export function buildLensPrompt(input: Omit<LensAgentInput, 'onWriting' | 'abortSignal'>): string {
  const range = input.head ? `${input.base} ${input.head}` : input.base
  const parts: string[] = [
    input.edit
      ? 'Change an existing review lens. A lens is a self-contained HTML artifact that helps a reviewer understand one code change.'
      : 'Make a review lens: a self-contained HTML artifact that helps a reviewer understand one code change.',
    '',
    `Resolved base: ${input.base}`,
    ...(input.head ? [`Resolved head: ${input.head}`] : []),
    `Resolved working tree: ${input.workTree}`,
    'The scope is already decided. This is an unattended background run: do not ask questions.',
    '',
    'Use the visual-artifacts skill for the Solus design system and the sandbox rules, but do NOT call',
    `render_artifact. Your only output is one \`${SUBMIT_REVIEW_LENS_TOOL_NAME}\` call with the complete HTML.`,
    '',
    'Rules for the HTML:',
    '- It runs in a sandbox with NO network access. Inline every style and script. Do not load',
    '  external scripts, stylesheets, fonts, or images, and do not call fetch.',
    '- Use the `var(--solus-…)` theme variables so the lens works in light and dark mode.',
    '- Put `data-solus-file="<repo-relative path>"` and `data-solus-line="<line in the new file>"` on',
    '  every element that shows one place in the change. A reviewer can comment on that element, and',
    '  the comment can go to the pull request on that line.',
    '- Base every fact on the diff. Do not invent files, functions, or behavior.',
    '',
  ]

  if (input.inlineDiff !== null) {
    parts.push('The complete diff is at the end of this message. Do not gather it again with git.', '')
  } else {
    parts.push(
      `Gather the change with \`git diff ${range} --stat\` and \`git diff ${range}\`.`,
      ...(input.head ? [] : ['List untracked files with `git ls-files --others --exclude-standard` and read them.']),
      '',
    )
  }

  if (input.ledger?.records.length) {
    parts.push(
      'Review ledger records from the sessions that made the change (JSON). Use them for intent; verify them against the diff:',
      JSON.stringify(input.ledger.records, null, 2),
      '',
    )
  }

  parts.push('Lens prompt from the user:', input.prompt.trim(), '')

  if (input.edit) {
    parts.push('Change requested now:', input.edit.prompt.trim() || '(Apply the comments below.)', '')
    if (input.edit.comments.length) {
      parts.push('Reviewer comments on the lens to apply:')
      for (const comment of input.edit.comments) {
        const where = comment.codeAnchor ? ` (${comment.codeAnchor.path}:${comment.codeAnchor.line})` : ''
        const quote = comment.quote ? ` on "${comment.quote.slice(0, 200)}"` : ''
        parts.push(`- [${comment.label}]${where}${quote}: ${comment.body.trim()}`)
      }
      parts.push('')
    }
    parts.push(
      'Keep everything the change request does not touch. Submit the complete new HTML, not a patch.',
      'The current lens HTML:',
      '```html',
      input.edit.html,
      '```',
      '',
    )
  }

  if (input.inlineDiff !== null) {
    parts.push(`Diff (\`git diff ${range}\`):`, '```diff', input.inlineDiff, '```', '')
  }
  return parts.join('\n')
}
