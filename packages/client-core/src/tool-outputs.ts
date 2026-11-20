import type { Message, ToolResultAudio, ToolResultImage } from '@solus/contracts/types'
import { solusAgentToolName } from '@solus/contracts/agent-tools'
import { toolResultImages, type ReplyImage } from './reply-images'
import { toolServerName } from './mcp-tool-label'

/**
 * Where a tool call's visible outputs show in a conversation, on desktop, web,
 * and mobile (docs/transcript-cards.md, "Tool outputs").
 *
 * The rule: an image goes to its turn's image gallery. Every other output that
 * a tool line shows only while it is open goes to the outputs strip under the
 * row that folds it. An output that already shows outside the folds stays
 * where it is. A new output field gets its place here: the type check and
 * tests/unit/tool-outputs.test.ts fail until it has one.
 */
export type ToolOutputPlace = 'gallery' | 'strip' | 'outside-fold'

/** The fields of a tool call's message that say what the call is, not what it gave back. */
export const TOOL_CALL_FACTS = ['toolName', 'toolId', 'toolIndex', 'toolInput', 'toolStatus', 'toolCompletedAt'] as const

/** Every field a tool call's message carries for the person to see. */
export type ToolOutputField = Exclude<Extract<keyof Message, `tool${string}`>, (typeof TOOL_CALL_FACTS)[number]> | 'errorHead'

export const TOOL_OUTPUT_PLACES = {
  toolImages: 'gallery',
  toolAudio: 'strip',
  toolLeftOut: 'strip',
  // The running row's label and rail say it, and a live turn folds nothing.
  toolProgress: 'outside-fold',
  // A failed row and a failed turn say so on their own line; the error head is the call's diagnosis.
  errorHead: 'outside-fold',
} as const satisfies Record<ToolOutputField, ToolOutputPlace>

/** One tool call, in the field names of the wire. Mobile maps its transcript item to it. */
export interface ToolCallOutputs {
  readonly id: string
  readonly toolName?: string
  readonly toolInput?: string | null
  readonly toolStatus?: 'running' | 'completed' | 'error'
  readonly toolImages?: readonly ToolResultImage[]
  readonly toolAudio?: readonly ToolResultAudio[]
  readonly toolLeftOut?: readonly string[]
}

/** A chip of the outputs strip. A chip opens the folds down to the tool line of `toolId`. */
export type ToolStripChip =
  | { readonly kind: 'audio'; readonly key: string; readonly toolId: string; readonly server: string; readonly format: string }
  | { readonly kind: 'left-out'; readonly key: string; readonly toolId: string; readonly count: number }

type FieldsIn<Place extends ToolOutputPlace> = {
  [Field in ToolOutputField]: (typeof TOOL_OUTPUT_PLACES)[Field] extends Place ? Field : never
}[ToolOutputField]

/** One chip maker for each strip field: a field moved to the strip does not type check without one. */
const STRIP_CHIPS: { readonly [Field in FieldsIn<'strip'>]: (tool: ToolCallOutputs) => ToolStripChip[] } = {
  toolAudio: (tool) =>
    (tool.toolAudio ?? []).map((audio) => ({
      kind: 'audio',
      key: `audio:${tool.id}:${audio.assetId}`,
      toolId: tool.id,
      server: toolServerName(tool.toolName ?? '', tool.toolInput) ?? 'Audio',
      format: audioFormat(audio),
    })),
  toolLeftOut: (tool) =>
    tool.toolLeftOut?.length ? [{ kind: 'left-out', key: `left-out:${tool.id}`, toolId: tool.id, count: tool.toolLeftOut.length }] : [],
}

/** One image reader for each gallery field. */
const GALLERY_IMAGES: { readonly [Field in FieldsIn<'gallery'>]: (tool: ToolCallOutputs) => ReplyImage[] } = {
  toolImages: (tool) => toolResultImages(tool.toolImages),
}

/** "MP3", from the stored file's extension. */
export function audioFormat(audio: ToolResultAudio): string {
  return audio.assetId.slice(audio.assetId.lastIndexOf('.') + 1).toUpperCase()
}

/**
 * The images one call adds to its turn's gallery, in the order it returned
 * them. A running call adds none. A browser capture is in the gallery already
 * as its capture card, so the scaled copy in its result is not added again.
 */
export function toolGalleryImages(tool: ToolCallOutputs): ReplyImage[] {
  if (tool.toolStatus === 'running' || solusAgentToolName(tool.toolName ?? '') === 'browser_snapshot') return []
  return (Object.keys(GALLERY_IMAGES) as FieldsIn<'gallery'>[]).flatMap((field) => GALLERY_IMAGES[field](tool))
}

/** The outputs strip of a folded row: the chips of its calls, in call order. A running call gives none. */
export function toolStripChips(tools: readonly ToolCallOutputs[]): ToolStripChip[] {
  const fields = Object.keys(STRIP_CHIPS) as FieldsIn<'strip'>[]
  return tools.flatMap((tool) => (tool.toolStatus === 'running' ? [] : fields.flatMap((field) => STRIP_CHIPS[field](tool))))
}

/** The gallery shows this many tool images in a turn; one more card opens them all. */
export const TOOL_GALLERY_LIMIT = 8

/** A tool image the gallery shows, with the call that returned it. */
export interface ToolGalleryImage {
  readonly toolId: string
  readonly image: ReplyImage
}

/** The tool images of a turn, in call order: the ones the gallery shows, all of them for the viewer, and how many the last card adds. */
export function turnToolGallery(tools: readonly ToolCallOutputs[]): { shown: ToolGalleryImage[]; all: ReplyImage[]; moreCount: number } {
  // Two calls can return the same picture: the gallery shows it once.
  const seen = new Set<string>()
  // Labels count across the turn, so three calls of one server read 1 to 12, not 1 to 4 three times.
  const counts = new Map<string, number>()
  const images = tools.flatMap((tool) => {
    const source = toolServerName(tool.toolName ?? '', tool.toolInput) ?? 'Tool'
    return toolGalleryImages(tool).flatMap((image) => {
      if (seen.has(image.href)) return []
      seen.add(image.href)
      const count = (counts.get(source) ?? 0) + 1
      counts.set(source, count)
      return [{ toolId: tool.id, image: { ...image, label: `${source} image ${count}` } }]
    })
  })
  const shown = images.slice(0, TOOL_GALLERY_LIMIT)
  return { shown, all: images.map(({ image }) => image), moreCount: images.length - shown.length }
}
