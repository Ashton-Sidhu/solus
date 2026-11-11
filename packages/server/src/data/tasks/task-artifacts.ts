import type { Attribution } from '@solus/contracts/user'
import type { TaskDetails } from '@solus/contracts/task-types'
import { renderArtifactPreview } from '../works/artifact-preview'
import { loadWork } from '../works/works'
import { createLogger } from '../../logger'
import { writeAssetUpload } from '../assets/assets'
import type { RecordScope } from '../../admission/principal'
import { taskAdapters } from './providers/registry'
import { cachedTask, commentOnTask } from './task'
import { taskHomeOf } from './task-store'
import type { TaskHome } from './providers/types'

const log = createLogger('main', 'task-artifacts.ts')

/**
 * Put an `artifact` work on a task.
 *
 * A provider cannot run the artifact, so the task gets what it can show: a
 * still of the render, and the HTML document itself where the provider takes
 * files. Both are host-owned assets (ADR-0015) in one task comment, which is
 * the one path that knows how to publish an asset to each provider and keep a
 * retry from uploading it twice.
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

export async function attachArtifactToTask(
  scope: RecordScope,
  taskId: string,
  workId: string,
  /** Who attached it: the comment is theirs. */
  by: Attribution,
): Promise<TaskDetails> {
  await cachedTask(taskId)
  const home = await taskHomeOf(taskId)
  // The work is read in the caller's scope: a task never shows a file its reader cannot open.
  const work = await loadWork(scope, workId)
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

  const sourceFileName = `${fileBase}.html`
  const includeSource = home !== null && sourceTravelsTo(home, source.uri, sourceFileName)

  const body = artifactCommentBody({
    title: work.title,
    previewUri: still.uri,
    sourceUri: source.uri,
    sourceFileName,
    includeSource,
  })
  log.info('task_artifact_attached', { taskId, workId, provider: home?.provider ?? null, includeSource })
  return commentOnTask(scope, taskId, { body, by })
}

/**
 * Whether the HTML goes with the still. The source goes only where the
 * provider can hold it, so the still is never held back by a file the task
 * cannot take: GitHub's upload endpoint accepts images and video only, while
 * Jira attaches any file.
 */
export function sourceTravelsTo(home: TaskHome, sourceUri: string, sourceFileName: string): boolean {
  return taskAdapters().provider(home.provider).unpublishableAssets(home, `[${sourceFileName}](${sourceUri})`).length === 0
}
