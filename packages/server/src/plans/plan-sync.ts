import type { RecordScope } from '../admission/principal'
import type { PlanPublishRequest, WorkExternalLink, WorkPublishResult, WorkPullResult } from '@solus/contracts/docs'
import type { PlanAnnotations } from '@solus/contracts/types'
import { publishMirror, pullMirror, refreshMirror } from '../docs/mirror'
import { loadAnnotations, saveAnnotations } from './annotations'

async function annotationsFor(scope: RecordScope, sessionId: string, planToolUseId: string): Promise<PlanAnnotations> {
  const annotations = await loadAnnotations(scope, sessionId, planToolUseId)
  if (!annotations) throw new Error('The plan must finish loading before it can be published.')
  return annotations
}

async function saveLink(
  scope: RecordScope,
  sessionId: string,
  planToolUseId: string,
  link: WorkExternalLink | undefined,
): Promise<void> {
  const next = await annotationsFor(scope, sessionId, planToolUseId)
  if (link) next.mirroredDoc = link
  else delete next.mirroredDoc
  await saveAnnotations(scope, next)
}

export async function publishPlan(scope: RecordScope, request: PlanPublishRequest): Promise<WorkPublishResult> {
  try {
    const annotations = await annotationsFor(scope, request.sessionId, request.planToolUseId)
    const result = await publishMirror({
      title: request.title,
      content: request.content,
      link: annotations.mirroredDoc,
      destination: request.destination,
      diagramAssets: request.diagramAssets,
      force: request.force,
    })
    if (result.link) await saveLink(scope, request.sessionId, request.planToolUseId, result.link)
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function pullPlanUpstream(scope: RecordScope, sessionId: string, planToolUseId: string): Promise<WorkPullResult> {
  try {
    const annotations = await annotationsFor(scope, sessionId, planToolUseId)
    const link = annotations.mirroredDoc
    if (!link) return { ok: false, error: 'This plan is not linked to an upstream document.' }
    const pulled = await pullMirror(link)
    await saveLink(scope, sessionId, planToolUseId, pulled.link)
    return pulled.result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function refreshPlanUpstream(scope: RecordScope, sessionId: string, planToolUseId: string): Promise<WorkExternalLink | null> {
  const annotations = await annotationsFor(scope, sessionId, planToolUseId)
  if (!annotations.mirroredDoc) return null
  const refreshed = await refreshMirror(annotations.mirroredDoc)
  if (refreshed !== annotations.mirroredDoc) await saveLink(scope, sessionId, planToolUseId, refreshed)
  return refreshed
}

export async function unlinkPlanUpstream(scope: RecordScope, sessionId: string, planToolUseId: string): Promise<void> {
  await saveLink(scope, sessionId, planToolUseId, undefined)
}
