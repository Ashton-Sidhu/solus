import type { PlanPublishRequest, WorkExternalLink, WorkPublishResult, WorkPullResult } from '@solus/contracts/docs'
import type { PlanAnnotations } from '@solus/contracts/types'
import { publishMirror, pullMirror, refreshMirror } from '../docs/mirror'
import { loadAnnotations, saveAnnotations } from './annotations'

async function annotationsFor(sessionId: string, planToolUseId: string): Promise<PlanAnnotations> {
  const annotations = await loadAnnotations(sessionId, planToolUseId)
  if (!annotations) throw new Error('The plan must finish loading before it can be published.')
  return annotations
}

async function saveLink(
  sessionId: string,
  planToolUseId: string,
  link: WorkExternalLink | undefined,
): Promise<void> {
  const next = await annotationsFor(sessionId, planToolUseId)
  if (link) next.mirroredDoc = link
  else delete next.mirroredDoc
  await saveAnnotations(next)
}

export async function publishPlan(request: PlanPublishRequest): Promise<WorkPublishResult> {
  try {
    const annotations = await annotationsFor(request.sessionId, request.planToolUseId)
    const result = await publishMirror({
      title: request.title,
      content: request.content,
      link: annotations.mirroredDoc,
      destination: request.destination,
      diagramAssets: request.diagramAssets,
      force: request.force,
    })
    if (result.link) await saveLink(request.sessionId, request.planToolUseId, result.link)
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function pullPlanUpstream(sessionId: string, planToolUseId: string): Promise<WorkPullResult> {
  try {
    const annotations = await annotationsFor(sessionId, planToolUseId)
    const link = annotations.mirroredDoc
    if (!link) return { ok: false, error: 'This plan is not linked to an upstream document.' }
    const pulled = await pullMirror(link)
    await saveLink(sessionId, planToolUseId, pulled.link)
    return pulled.result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function refreshPlanUpstream(sessionId: string, planToolUseId: string): Promise<WorkExternalLink | null> {
  const annotations = await annotationsFor(sessionId, planToolUseId)
  if (!annotations.mirroredDoc) return null
  const refreshed = await refreshMirror(annotations.mirroredDoc)
  if (refreshed !== annotations.mirroredDoc) await saveLink(sessionId, planToolUseId, refreshed)
  return refreshed
}

export async function unlinkPlanUpstream(sessionId: string, planToolUseId: string): Promise<void> {
  await saveLink(sessionId, planToolUseId, undefined)
}
