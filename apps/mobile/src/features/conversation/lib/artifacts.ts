import { z } from 'zod'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { WireNormalizedEvent } from '@solus/contracts/types'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'

/**
 * The HTML renders an agent shows in the conversation (`render_artifact`, and
 * `update_work` on an artifact work), read by the rules of the desktop
 * transcript (`session-transcript.ts`, `work-stream-tracker.svelte.ts`).
 *
 * A call that names an `html_path` has no HTML in its input. Its render keeps
 * the content version the receipt names, and the card reads that version of
 * the work (`ConversationController.ensureArtifact`). Not read here yet: image
 * artifacts and a call still being written. Each shows as its tool row only.
 */

export interface ArtifactRender {
  html: string
  title: string
  /** The `artifact` work the render was saved as. Revisions of one work share it. */
  workId: string | null
  /** The work version an `html_path` call saved. Its HTML is empty until the card reads it. */
  contentVersion?: number
  /** The saved version is being read. */
  loading?: boolean
  /** The saved version could not be read; the card offers a retry. */
  error?: string
}

const renderInput = z.object({
  kind: z.enum(['image', 'html']).optional().catch(undefined),
  html: z.string().optional(),
  html_path: z.string().optional(),
  title: z.string().optional().catch(undefined),
  preview: z.boolean().optional().catch(undefined),
})

const updateInput = z.object({
  work_id: z.string(),
  content: z.string().optional(),
  html_path: z.string().optional(),
})

/** Claude names the tool `mcp__solus__render_artifact`; Codex `render_artifact`. */
function isRenderArtifactTool(toolName: string): boolean {
  return toolName.endsWith('render_artifact')
}

/** A call's input, read by `schema`; null when it does not match. */
function parseInput<T>(schema: z.ZodType<T>, text: string | null): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text || '{}'))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

type ArtifactWorkRef = WireSessionLoadMessage['artifactWorkRef']

/** The render a finished call in history shows, or null when it shows none. */
export function artifactFromHistory(toolName: string, toolInput: string | null, result: WireSessionLoadMessage): ArtifactRender | null {
  if (result.status === 'error') return null
  if (isRenderArtifactTool(toolName)) return renderFromHistory(toolInput, result.artifactWorkRef)
  if (toolName.endsWith('update_work')) return updateFromHistory(toolInput, result.artifactWorkRef)
  return null
}

function renderFromHistory(toolInput: string | null, ref: ArtifactWorkRef): ArtifactRender | null {
  const input = parseInput(renderInput, toolInput)
  // A preview is the agent's own check: it showed nothing live.
  if (!input || input.preview || input.kind === 'image') return null
  if (input.html) {
    return { html: input.html, title: ref?.title ?? resolveArtifactTitle(input.title, input.html), workId: ref?.workId ?? null }
  }
  if (!input.html_path || !ref?.contentVersion) return null
  return { html: '', title: ref.title, workId: ref.workId, contentVersion: ref.contentVersion }
}

function updateFromHistory(toolInput: string | null, ref: ArtifactWorkRef): ArtifactRender | null {
  // Only the receipt says the work is an artifact: never guess from the content.
  const input = parseInput(updateInput, toolInput)
  if (!input || !ref || ref.workId !== input.work_id) return null
  if (input.content !== undefined) return { html: input.content, title: ref.title, workId: ref.workId }
  if (!input.html_path || !ref.contentVersion) return null
  return { html: '', title: ref.title, workId: ref.workId, contentVersion: ref.contentVersion }
}

/** The render a live `artifact_created` event shows. */
export function artifactFromCreated(event: Extract<WireNormalizedEvent, { type: 'artifact_created' }>): ArtifactRender | null {
  if (event.kind !== 'html' || !event.html) return null
  return { html: event.html, title: resolveArtifactTitle(event.title, event.html), workId: event.workId ?? null }
}
