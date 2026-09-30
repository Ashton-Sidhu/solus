import { z } from 'zod'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { SolusApiError } from '../../../admission/workspace-error'
import { foreignLinkedItemFor } from '../../../data/tasks/foreign-tasks'
import type { AgentTool } from './agent-tool'

const requestWorkReviewFields = {
  work_id: z.string().describe('The id of the work to review (from find_works).'),
  reviewer_ids: z.array(z.string().min(1)).min(1).max(50).describe('The user ids of the organization members to ask. A member who cannot open the work is given it as a commenter.'),
  message: z.string().max(2000).optional().describe('An optional note that tells the reviewers what to look at.'),
  expected_content_version: z.number().int().min(0).describe('The content_version that read_work returned. The reviewers are asked about exactly that version; if the work changed since, nothing is requested and you must read it again.'),
}

const REQUEST_REVIEW_DESC = [
  'Ask members of the work\'s organization to review a document, diagram, or artifact. Each reviewer can approve it, request changes, or comment.',
  'Review is information only: it does not block publishing or editing. Use it when the user asks for a review or sign-off.',
  'Call read_work first and pass its content_version as expected_content_version. Reviewers are named by user id; a Local work has no organization to ask.',
].join('\n')

/** The same tool for Claude and Codex. It goes through the workspace operations,
 *  so an organization session asks its Solus API and every other session this host. */
export const requestWorkReviewAgentTool: AgentTool<typeof requestWorkReviewFields> = {
  name: 'request_work_review',
  description: REQUEST_REVIEW_DESC,
  inputFields: requestWorkReviewFields,
  requiresApproval: false,
  async execute(args, context) {
    if (foreignLinkedItemFor(context.solusSessionId(), 'work', args.work_id)) {
      return { ok: false, text: 'This work lives on the task\'s host, which this session cannot ask for a review. Ask the user to request the review in Solus.' }
    }
    try {
      const { operations, context: home } = await workspaceToolContext(context.sessionId(), context.solusSessionId())
      const review = await operations.requestWorkReview(home, args.work_id, {
        reviewerIds: args.reviewer_ids,
        message: args.message,
        expectedContentVersion: args.expected_content_version,
      })
      const waiting = review.reviewers.filter((reviewer) => reviewer.isAwaiting).map((reviewer) => reviewer.displayName)
      return { ok: true, text: `Review requested from ${waiting.join(', ')}. Review state: ${review.state.replace('_', ' ')}.` }
    } catch (error) {
      if (error instanceof SolusApiError && error.code === 'STALE_VERSION') {
        return { ok: false, text: `Stale request: the work changed after you read it at content_version ${args.expected_content_version}. Nothing was requested. Call read_work again and pass its content_version.` }
      }
      return { ok: false, text: `Could not request a review: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}
