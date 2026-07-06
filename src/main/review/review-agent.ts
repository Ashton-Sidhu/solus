import { ClaudeAgent, SAFE_TOOLS, type CanUseTool } from '../agents/claude/claude-agent'
import { runCodexOneShot } from '../agents/codex/codex-oneshot'
import { createLogger } from '../logger'
import type { ReviewContext, ReviewLedger, ReviewGuideDraft } from '../../shared/review'
import type { AgentId, ReasoningEffort } from '../../shared/types'
import type { ReviewProgressStep } from '../../shared/review'
import {
  registerCodexReviewGuideCapture,
  reviewGuideMcpServer,
  SUBMIT_REVIEW_GUIDE_MCP_TOOL,
  SUBMIT_REVIEW_GUIDE_TOOL_JSON_SCHEMA,
  SUBMIT_REVIEW_GUIDE_TOOL_NAME,
} from './review-guide-tool'

const log = createLogger('review', 'review-agent.ts')

// ─── read-only enforcement ───
//
// The prompt says "you are strictly read-only", but prompts don't enforce.
// SAFE_TOOLS (pre-approved via allowedTools) contains no Bash and no edit
// tools, so everything else lands in this gate: Bash is allowed only for
// read-only git subcommands (the prompt tells the agent to gather the diff
// itself), and every other tool — Write, Edit, arbitrary shell — is denied.
// permissionMode must stay 'ask': 'auto' (acceptEdits) would approve file
// edits before this gate is ever consulted.

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'status', 'ls-files', 'blame', 'grep',
  'rev-parse', 'merge-base', 'cat-file', 'shortlog', 'describe',
])

/** Chaining/redirection would let a read-only git command smuggle in writes
 *  (`git diff | tee`, `git log; rm …`), so any metacharacter fails the check. */
const SHELL_METACHARACTERS = /[;&|<>`$\n]/

function isReadOnlyGitCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  if (SHELL_METACHARACTERS.test(command)) return false
  const m = command.trim().match(/^git\s+(?:-C\s+\S+\s+)?(?:--no-pager\s+)?(\S+)/)
  return !!m && READ_ONLY_GIT_SUBCOMMANDS.has(m[1])
}

const reviewReadOnlyGate: CanUseTool = async (toolName, input) => {
  if (toolName === 'Bash' && isReadOnlyGitCommand(input?.command)) {
    return { behavior: 'allow', updatedInput: input }
  }
  return {
    behavior: 'deny',
    message: toolName === 'Bash'
      ? 'This review is read-only: Bash is limited to read-only git commands (diff, log, show, status, ls-files, blame, grep, …) with no chaining or redirection.'
      : `This review is read-only: ${toolName} is not permitted. Use the read tools and submit the guide via ${SUBMIT_REVIEW_GUIDE_TOOL_NAME}.`,
  }
}

// A single session-agnostic Claude agent drives every Claude-backed review, the
// same pattern automations use (no IpcContext, no permission UI). The Codex path
// goes through runCodexOneShot, which talks to the shared app-server client.
const claudeAgent = new ClaudeAgent()

export interface ReviewAgentInput {
  /** Directory the agent runs git in — the worktree holding the live edits. */
  workTree: string
  /** Resolved diff base (the episode base SHA, or 'HEAD' when unresolved). */
  base: string
  ledger: ReviewLedger | null
  context: ReviewContext
  agent: AgentId
  model?: string | null
  /** Reasoning effort for the review run; falls back to 'high' when unset. */
  reasoningEffort?: ReasoningEffort | null
  /** Phase callback so the producer can stream progress to the UI. */
  onProgress?: (step: ReviewProgressStep) => void
  abortSignal?: AbortSignal
}

/**
 * Run the review agent and return the structured guide it authored. The agent
 * gathers the diff ITSELF with git (the prompt tells it how), so the change never
 * bloats the prompt; the ledger, when present, is the only context handed inline.
 *
 * The guide arrives as the arguments of a `submit_review_guide` tool call — the
 * same structured-tool pattern record_change uses (see review-guide-tool.ts) —
 * so there is no text-scrape. Claude calls the tool through an in-process MCP
 * server; the Codex one-shot calls it via dynamicTools. Returns null when the
 * agent never produced a usable guide, so the producer can fall back.
 */
export async function runReviewAgent(input: ReviewAgentInput): Promise<ReviewGuideDraft | null> {
  const ledgerPresent = !!input.ledger && input.ledger.records.length > 0
  const prompt = buildPrompt(input, ledgerPresent)
  const reasoningEffort = input.reasoningEffort ?? 'high'

  let captured: ReviewGuideDraft | null = null
  let unregisterCodexCapture: () => void = () => {}

  try {
    if (input.agent === 'codex') {
      await runCodexOneShot({
        prompt,
        cwd: input.workTree,
        model: input.model,
        reasoningEffort,
        abortSignal: input.abortSignal,
        ephemeral: false,
        readOnly: true,
        dynamicTools: [SUBMIT_REVIEW_GUIDE_TOOL_JSON_SCHEMA],
        onThreadStart: (threadId) => {
          unregisterCodexCapture = registerCodexReviewGuideCapture(threadId, (guide) => {
            input.onProgress?.('writing')
            captured = guide
          })
        },
      })
    } else {
      // Drive the run via its event stream (instead of runOneShot) so we can
      // flip to the 'writing' step the moment it calls the submit tool.
      const { events, result } = claudeAgent.run({
        prompt,
        cwd: input.workTree,
        model: input.model ?? undefined,
        reasoningEffort,
        permissionMode: 'ask',
        canUseTool: reviewReadOnlyGate,
        persistSession: false,
        abortController: abortControllerFromSignal(input.abortSignal),
        mcpServers: { solus: reviewGuideMcpServer((g) => { captured = g }) },
        allowedTools: [...SAFE_TOOLS, SUBMIT_REVIEW_GUIDE_MCP_TOOL],
      })
      for await (const evt of events) {
        if (evt.type !== 'tool_call') continue
        if (evt.toolName.includes(SUBMIT_REVIEW_GUIDE_TOOL_NAME)) {
          input.onProgress?.('writing')
        }
      }
      await result
    }
  } catch (err) {
    // Don't return here: a late stream error (budget cut, transport hiccup)
    // must not discard a guide the agent already submitted.
    log.error(`review agent run failed (${input.agent}): ${String(err)}`)
  } finally {
    unregisterCodexCapture()
  }

  if (!captured) {
    log.warn(`review agent (${input.agent}) returned no usable guide`)
    return null
  }
  return captured
}

function abortControllerFromSignal(signal?: AbortSignal): AbortController | undefined {
  if (!signal) return undefined
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

// ─── prompt ───

function buildPrompt(input: ReviewAgentInput, ledgerPresent: boolean): string {
  const { context } = input
  const reviewer = `${input.agent}/${input.model ?? 'default'}`
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
  return parts.join('\n')
}
