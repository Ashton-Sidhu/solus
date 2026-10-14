import { z } from 'zod'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { WireNormalizedEvent } from '@solus/contracts/types'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'

/**
 * The HTML renders an agent shows in the conversation (`render_artifact`, and
 * `update_work` on an artifact work), read by the rules of the desktop
 * transcript (`session-transcript.ts`, `work-stream-tracker.svelte.ts`).
 *
 * Not read here yet: image artifacts, a call that names an `html_path` (its
 * HTML is a saved revision the client must fetch), and a call still being
 * written. Each shows as its tool row only.
 */

export interface ArtifactRender {
  html: string
  title: string
  /** The `artifact` work the render was saved as. Revisions of one work share it. */
  workId: string | null
}

const renderInput = z.object({
  kind: z.enum(['image', 'html']).optional().catch(undefined),
  html: z.string().optional(),
  title: z.string().optional().catch(undefined),
  preview: z.boolean().optional().catch(undefined),
})

const updateInput = z.object({ work_id: z.string(), content: z.string().optional() })

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

/** The render a finished call in history shows, or null when it shows none. */
export function artifactFromHistory(toolName: string, toolInput: string | null, result: WireSessionLoadMessage): ArtifactRender | null {
  if (result.status === 'error') return null
  const ref = result.artifactWorkRef
  if (isRenderArtifactTool(toolName)) {
    const input = parseInput(renderInput, toolInput)
    // A preview is the agent's own check: it showed nothing live.
    if (!input?.html || input.preview || input.kind === 'image') return null
    return { html: input.html, title: ref?.title ?? resolveArtifactTitle(input.title, input.html), workId: ref?.workId ?? null }
  }
  if (toolName.endsWith('update_work')) {
    // Only the receipt says the work is an artifact: never guess from the content.
    const input = parseInput(updateInput, toolInput)
    if (!input || !ref || ref.workId !== input.work_id || input.content === undefined) return null
    return { html: input.content, title: ref.title, workId: ref.workId }
  }
  return null
}

/** The render a live `artifact_created` event shows. */
export function artifactFromCreated(event: Extract<WireNormalizedEvent, { type: 'artifact_created' }>): ArtifactRender | null {
  if (event.kind !== 'html' || !event.html) return null
  return { html: event.html, title: resolveArtifactTitle(event.title, event.html), workId: event.workId ?? null }
}
