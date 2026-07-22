import type { ReviewDraftComment } from '../../shared/review'

export interface PrFixFeedback {
  body: string
  comments: ReviewDraftComment[]
}

export function buildPrCommentsFixPrompt(
  pr: { number: number; title: string },
  feedback?: PrFixFeedback,
): string {
  const submittedFeedback = feedback
    ? `\n\n## Feedback that triggered this run\n\nThe review may have just been submitted and not yet appear in the provider API. Use this exact feedback as a fallback.\n\n### Review summary\n\n${feedback.body.trim() || 'No overall review summary was provided.'}\n\n### Inline comments\n\n${feedback.comments.length > 0
    ? feedback.comments.map((comment, index) => {
        const lines = comment.startLine !== undefined && comment.startLine !== comment.line
          ? `${comment.startLine}-${comment.line}`
          : String(comment.line)
        return `${index + 1}. ${comment.path}:${lines} (${comment.side === 'old' ? 'LEFT' : 'RIGHT'})\n${comment.body.trim()}`
      }).join('\n\n')
    : 'No inline comments were provided.'}`
    : ''

  return `Address all actionable review feedback for PR #${pr.number}: ${pr.title} in this worktree.

1. Call read_pr for PR #${pr.number} and review its top-level conversation for actionable feedback.
2. Call list_pr_threads for PR #${pr.number} and inspect every unresolved inline thread.
3. Verify each request against the current code. Implement the appropriate fixes, including related edge cases.
4. Run the relevant tests and checks.
5. Commit the completed changes.

If feedback is obsolete, already satisfied, or conflicts with another request, explain that in your final response instead of making a speculative change.${submittedFeedback}

Do NOT push, reply to, or resolve PR threads. The reviewer will inspect the local fix commit before publishing it or updating remote review state.`
}
