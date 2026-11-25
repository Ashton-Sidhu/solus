import { isArtifactRenderTool } from '@solus/contracts/agent-tools'
import { artifactPageAttachmentId, type ArtifactLayout } from '@solus/contracts/artifact-page'
import { UNMEASURED_REPLY_HEIGHT, type WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { WireNormalizedEvent } from '@solus/contracts/types'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'

/**
 * The HTML renders an agent shows in the conversation (`render_artifact`, and
 * `update_work` on an artifact work), read by the rules of the desktop
 * transcript (`session-transcript.ts`, `work-stream-tracker.svelte.ts`).
 *
 * A render names one saved version of its work. The phone loads that version
 * as a page from its host (`docs/plans/mobile-artifact-pages.md`), so the
 * transcript holds no HTML. Not read here: image artifacts and a call still
 * being written. Each shows as its tool row only.
 */

export interface ArtifactRender {
  title: string
  /** The `artifact` work the render was saved as. Revisions of one work share it. */
  workId: string
  /** The saved version this render shows. */
  contentVersion: number
  /** The frame the host measured for that version. */
  layout?: ArtifactLayout
}

/** The T3 `html_render` reference of a render: its page id and the frame it fits. */
export function artifactHtmlRender(render: ArtifactRender) {
  return {
    attachmentId: artifactPageAttachmentId(render.workId, render.contentVersion),
    title: render.title,
    // A version the host never measured gets the fixed frame of an unmeasured reply and scrolls in it.
    height: render.layout?.height ?? UNMEASURED_REPLY_HEIGHT,
    ...(render.layout?.heights && { heights: render.layout.heights }),
  }
}

/** The render a finished call in history shows, or null when it shows none.
 *  Only the receipt names a saved artifact version: a preview, an update of
 *  another kind of work, and a failed call name none. */
export function artifactFromHistory(toolName: string, result: WireSessionLoadMessage): ArtifactRender | null {
  if (result.status === 'error') return null
  if (!isArtifactRenderTool(toolName) && !toolName.endsWith('update_work')) return null
  const ref = result.artifactWorkRef
  if (!ref?.contentVersion) return null
  return { title: ref.title, workId: ref.workId, contentVersion: ref.contentVersion, ...(ref.layout && { layout: ref.layout }) }
}

/** A new work's first body is version 1. An older host names no version. */
const NEW_WORK_CONTENT_VERSION = 1

/** The render a live `artifact_created` event shows. */
export function artifactFromCreated(event: Extract<WireNormalizedEvent, { type: 'artifact_created' }>): ArtifactRender | null {
  if (event.kind !== 'html' || !event.workId) return null
  return {
    title: resolveArtifactTitle(event.title, event.html ?? ''),
    workId: event.workId,
    contentVersion: event.contentVersion ?? NEW_WORK_CONTENT_VERSION,
    ...(event.layout && { layout: event.layout }),
  }
}
