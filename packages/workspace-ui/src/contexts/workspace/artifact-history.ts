import { z } from 'zod'
import type { Message, Work } from '@solus/contracts/types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'
import { nextMsgId } from './session.utils'

const updateInput = z.object({ work_id: z.string(), content: z.string(), title: z.string().optional() })

/** Input alone can be a denied/interrupted call. Only a successful receipt
 * creates a revision. Never use today's work content for yesterday's preview. */
export function artifactUpdateFromHistory(
  tool: WireSessionLoadMessage,
  result: WireSessionLoadMessage,
  getWork: (workId: string) => Work | undefined,
): Message | undefined {
  if (result.status !== 'ok' || tool.toolStatus === 'error' || (!result.artifactWorkRef && !result.workUpdateSucceeded)) return
  try {
    const input = updateInput.parse(JSON.parse(tool.toolInput || '{}'))
    const work = result.artifactWorkRef ? undefined : getWork(input.work_id)
    const ref = result.artifactWorkRef ?? (work?.type === 'artifact'
      ? { workId: input.work_id, title: input.title ?? resolveArtifactTitle(undefined, input.content) }
      : undefined)
    if (!ref || ref.workId !== input.work_id) return
    return {
      id: nextMsgId(), role: 'assistant', content: '',
      artifact: { kind: 'html', html: input.content },
      workRef: { ...ref, workType: 'artifact' },
      timestamp: result.timestamp ?? tool.timestamp ?? Date.now(),
    }
  } catch { return undefined }
}
