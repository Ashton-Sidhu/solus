import { z } from 'zod'
import { reviewGuideKeyForTarget, type ReviewGuideReference } from '@solus/contracts/review'
import type { Message } from '@solus/contracts/types'

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('working-tree') }),
  z.object({ kind: z.literal('session'), sessionId: z.string().optional() }),
  z.object({ kind: z.literal('branch'), targetBranch: z.string().optional() }),
  z.object({
    kind: z.literal('pr'),
    host: z.string(),
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive(),
    url: z.string().optional(),
    baseSha: z.string().optional(),
    headSha: z.string().optional(),
  }),
])

const requestSchema = z.object({ target: targetSchema })

export function isRequestReviewGuideTool(name: string | undefined): boolean {
  return !!name && name.endsWith('request_review_guide')
}

export function reviewGuideTargetLabel(target: ReviewGuideReference['target']): string {
  return target.kind === 'working-tree'
    ? 'Working tree'
    : target.kind === 'session'
      ? 'Session changes'
      : target.kind === 'branch'
        ? 'Branch changes'
        : `Pull request #${target.number}`
}

export function reviewGuideReferenceFromToolInput(
  toolInput: string | undefined,
  branch: string | null | undefined,
  sessionId: string | null | undefined,
): ReviewGuideReference | null {
  try {
    const { target } = requestSchema.parse(JSON.parse(toolInput || '{}'))
    return {
      target,
      key: reviewGuideKeyForTarget(target, branch ?? 'detached', sessionId ?? null),
    }
  } catch {
    return null
  }
}

/** A running request tool is the source of truth for the loading skeleton. It
 * exists before the durable assistant reference and survives renderer reloads
 * without requiring the event reducer to manufacture a second live message. */
export function runningReviewGuideReference(
  tools: Message[],
  branch: string | null | undefined,
  sessionId: string | null | undefined,
): ReviewGuideReference | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i]
    if (tool.toolStatus !== 'running' || !isRequestReviewGuideTool(tool.toolName)) continue
    return reviewGuideReferenceFromToolInput(tool.toolInput, branch, sessionId)
  }
  return null
}
