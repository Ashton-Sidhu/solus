import { REVIEW_GUIDE_CONTEXT } from '@solus/contracts/injected-context'
import { parseReviewCommand } from '@solus/contracts/review'
import { resolveRepoRoot } from '../git/git-helpers'
import { listTurnSnapshots } from '../git/session-snapshots'
import { resolveHomePath } from '../platform/paths'

/** Resolve the command when it reaches the provider. A queued request then
 * includes the turn that just finished, and its reply lives in the conversation. */
export async function inlineSessionGuidePrompt(prompt: string, sessionId: string, cwd?: string | null): Promise<string> {
  const command = parseReviewCommand(prompt)
  if (command?.mode !== 'session') return prompt

  const repo = cwd ? await resolveRepoRoot(resolveHomePath(cwd)) : null
  const turns = repo ? await listTurnSnapshots(repo, sessionId) : []
  const prefix = prompt + REVIEW_GUIDE_CONTEXT
  const instructions = [
    'Write a read-only review guide for the code changes in this session. Group related changes and explain what to verify.',
    'Use only the before and after Git trees listed below, in order. Inspect each with git diff --no-ext-diff BEFORE AFTER -- from the checkout. Account for later revisions and reversals. Do not diff HEAD or the live checkout.',
    'Return one ```review-guide fence containing valid JSON with this shape:',
    '{"title":"…","summary":"…","sections":[{"title":"…","significance":"core","explanation":"What changed and what to verify (Markdown)","files":[{"turn":1,"path":"repo/relative/path"}]}]}',
    'Order sections as core, supporting, then low-signal. An optional attention object has kind (tradeoff, contract, product, risk, or accessibility) and note.',
    'Each file names the numbered turn whose patch shows the change. Before replying, check each cited path against that turn’s Git diff. Copy the full repository-relative post-image path (original path for deletions). Include a path only once per section. Explain revisions or reversals and cite the relevant turns.',
    'Solus loads the actual diffs. Do not write HTML, copy patches, save a work, or call submit_review_guide.',
  ]
  if (!turns.length) return prefix + 'Tell the user that this session has no captured turn snapshots to review.'
  let missing = 0
  const ranges: string[] = []
  for (const turn of turns) {
    if (!turn.fromTreeSha || !turn.toTreeSha) missing++
    else if (turn.fromTreeSha !== turn.toTreeSha) ranges.push(`Turn ${turn.index + 1}: ${turn.fromTreeSha} ${turn.toTreeSha}`)
  }
  const missingNote = missing ? `Mention that ${missing} captured turns lack a before or after tree and could not be reviewed.` : ''
  if (!ranges.length) return prefix + ['Report that the available snapshot pairs contain no code changes.', missingNote].filter(Boolean).join(' ')
  if (missingNote) instructions.push(missingNote)
  return prefix + [...instructions, ...ranges].join('\n\n')
}
