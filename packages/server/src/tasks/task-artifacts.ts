import type { TaskDetails } from '@solus/contracts/task-types'
import { renderArtifactPreview } from '../folio/artifact-preview'
import { loadWork } from '../folio/works'
import { createLogger } from '../logger'
import { writeAssetUpload } from '../server/assets'
import { blockedAssetReferences } from './adapters/registry'
import { Task } from './task'
import { externalLinkForTask } from './task-sync-store'

const log = createLogger('main', 'task-artifacts.ts')

/**
 * Put an `artifact` work on a task's ticket.
 *
 * A ticket cannot run the artifact, so it gets what it can show: a still of
 * the render, and the HTML document itself where the provider takes files.
 * Both land as host-owned assets (ADR-0015) in one task comment, which is the
 * one path that already knows how to publish an asset to each provider and
 * keep a retry from uploading it twice. The comment is the durable record;
 * the ticket is derived from it at sync time and never written back.
 */

export interface ArtifactCommentParts {
  title: string
  /** `asset://…png` of the still. */
  previewUri: string
  /** `asset://…html` of the document, and the name it is offered under. */
  sourceUri: string
  sourceFileName: string
  /** False when the linked provider refuses `.html` (GitHub's upload endpoint
   *  takes images and video only): the still goes alone, and the comment says
   *  where the interactive copy lives. */
  includeSource: boolean
}

export function artifactCommentBody(parts: ArtifactCommentParts): string {
  const lines = [`![${parts.title}](${parts.previewUri})`, '']
  if (parts.includeSource) {
    lines.push(`Interactive artifact “${parts.title}” — source: [${parts.sourceFileName}](${parts.sourceUri})`)
  } else {
    lines.push(`Interactive artifact “${parts.title}” — the interactive copy is open in Solus.`)
  }
  return lines.join('\n')
}

/** A file name a ticket reader can make sense of, from the work's title. */
export function artifactFileBase(title: string): string {
  return title.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80) || 'artifact'
}

export async function attachArtifactToTask(taskId: string, workId: string, cwd?: string): Promise<TaskDetails> {
  const task = await Task.byId(taskId)
  const work = await loadWork(workId, cwd)
  if (!work) throw new Error('This artifact no longer exists.')
  if (work.type !== 'artifact') throw new Error(`"${work.title}" is a ${work.type}, not an artifact.`)
  if (!work.content.trim()) throw new Error(`"${work.title}" is empty; there is nothing to render.`)

  const fileBase = artifactFileBase(work.title)
  const preview = await renderArtifactPreview(work.content)
  const still = await writeAssetUpload({ name: `${fileBase}.png`, mime: 'image/png', dataUrl: preview })
  const source = await writeAssetUpload({
    name: `${fileBase}.html`,
    mime: 'text/html',
    dataUrl: `data:text/html;base64,${Buffer.from(work.content, 'utf8').toString('base64')}`,
  })

  const provider = externalLinkForTask(taskId)?.provider ?? null
  const sourceFileName = `${fileBase}.html`
  const includeSource = sourceTravelsTo(provider, source.uri, sourceFileName)

  const body = artifactCommentBody({
    title: work.title,
    previewUri: still.uri,
    sourceUri: source.uri,
    sourceFileName,
    includeSource,
  })
  log.info('task_artifact_attached', { taskId, workId, provider, includeSource })
  return task.comment(body, { pushToExternal: true })
}

/**
 * Whether the HTML rides along with the still. With no ticket the comment
 * stays local and Solus renders both; with one, the source goes only where
 * the provider can host it, so the still is never held back by a file the
 * ticket cannot take — GitHub's upload endpoint accepts images and video
 * only, while Jira attaches any file.
 */
export function sourceTravelsTo(provider: string | null, sourceUri: string, sourceFileName: string): boolean {
  if (!provider) return true
  return blockedAssetReferences(`[${sourceFileName}](${sourceUri})`, provider).length === 0
}
