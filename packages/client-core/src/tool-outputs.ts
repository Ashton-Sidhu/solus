import type { Message, ToolResultAudio, ToolResultImage } from '@solus/contracts/types'
import { solusAgentToolName } from '@solus/contracts/agent-tools'
import { toolResultImages, type ReplyImage } from './reply-images'
import { toolServerName } from './mcp-tool-label'

/**
 * Where a tool call's visible outputs show in a conversation, on desktop, web,
 * and mobile (docs/transcript-cards.md, "Tool outputs").
 *
 * The rule: every output that a tool line shows only while it is open goes to
 * the outputs strip under the row that folds it. An output that already shows
 * outside the folds stays where it is. Tool images do not go to the turn's
 * image gallery: it holds the final output of the turn. A new output field
 * gets its place here: the type check and tests/unit/tool-outputs.test.ts fail
 * until it has one.
 */
export type ToolOutputPlace = 'strip' | 'outside-fold'

/** The fields of a tool call's message that say what the call is, not what it gave back. */
export const TOOL_CALL_FACTS = ['toolName', 'toolId', 'toolIndex', 'toolInput', 'toolStatus', 'toolCompletedAt'] as const

/** Every field a tool call's message carries for the person to see. */
export type ToolOutputField = Exclude<Extract<keyof Message, `tool${string}`>, (typeof TOOL_CALL_FACTS)[number]> | 'errorHead'

export const TOOL_OUTPUT_PLACES = {
  toolImages: 'strip',
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

/**
 * An item of the outputs strip. A thumbnail opens the image viewer on the
 * images of its row; a chip opens the folds down to the tool line of `toolId`.
 */
export type ToolStripItem =
  | { readonly kind: 'image'; readonly key: string; readonly toolId: string; readonly image: ReplyImage }
  | { readonly kind: 'audio'; readonly key: string; readonly toolId: string; readonly server: string; readonly format: string }
  | { readonly kind: 'left-out'; readonly key: string; readonly toolId: string; readonly count: number }

export type ToolStripImage = Extract<ToolStripItem, { kind: 'image' }>
export type ToolStripChip = Exclude<ToolStripItem, { kind: 'image' }>

type FieldsIn<Place extends ToolOutputPlace> = {
  [Field in ToolOutputField]: (typeof TOOL_OUTPUT_PLACES)[Field] extends Place ? Field : never
}[ToolOutputField]

/** One item maker for each strip field: a field moved to the strip does not type check without one. */
const STRIP_ITEMS: { readonly [Field in FieldsIn<'strip'>]: (tool: ToolCallOutputs) => ToolStripItem[] } = {
  // A browser capture shows outside the folds as its capture card, so the
  // scaled copy in its result is not added again.
  toolImages: (tool) =>
    solusAgentToolName(tool.toolName ?? '') === 'browser_snapshot'
      ? []
      : toolResultImages(tool.toolImages).map((image) => ({ kind: 'image', key: `image:${image.href}`, toolId: tool.id, image })),
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

/** "MP3", from the stored file's extension. */
export function audioFormat(audio: ToolResultAudio): string {
  return audio.assetId.slice(audio.assetId.lastIndexOf('.') + 1).toUpperCase()
}

/** The strip shows this many thumbnails; one more tile opens the rest. */
export const TOOL_STRIP_IMAGE_LIMIT = 6

/** The outputs strip of a folded row. */
export interface ToolStrip {
  /** The thumbnails the strip shows, in call order. */
  readonly thumbnails: readonly ToolStripImage[]
  /** Every image of the row, in call order: the viewer a thumbnail opens browses them. */
  readonly images: readonly ReplyImage[]
  /** The images past the limit, which the `+N` tile opens. */
  readonly moreCount: number
  /** The audio and left-out chips, in call order, after the thumbnails. */
  readonly chips: readonly ToolStripChip[]
}

export const EMPTY_TOOL_STRIP: ToolStrip = { thumbnails: [], images: [], moreCount: 0, chips: [] }

/** The outputs strip of a folded row, from the calls it folds. A running call gives nothing. */
export function toolStrip(tools: readonly ToolCallOutputs[]): ToolStrip {
  const fields = Object.keys(STRIP_ITEMS) as FieldsIn<'strip'>[]
  const items = tools.flatMap((tool) => (tool.toolStatus === 'running' ? [] : fields.flatMap((field) => STRIP_ITEMS[field](tool))))
  const images: ToolStripImage[] = []
  const chips: ToolStripChip[] = []
  // Two calls can return the same picture: the strip shows it once.
  const seen = new Set<string>()
  // Labels count across the row, so three calls of one server read 1 to 12, not 1 to 4 three times.
  const counts = new Map<string, number>()
  const sources = new Map(tools.map((tool) => [tool.id, toolServerName(tool.toolName ?? '', tool.toolInput) ?? 'Tool']))
  for (const item of items) {
    if (item.kind !== 'image') {
      chips.push(item)
      continue
    }
    if (seen.has(item.image.href)) continue
    seen.add(item.image.href)
    const source = sources.get(item.toolId) ?? 'Tool'
    const count = (counts.get(source) ?? 0) + 1
    counts.set(source, count)
    images.push({ ...item, image: { ...item.image, label: `${source} image ${count}` } })
  }
  if (images.length === 0 && chips.length === 0) return EMPTY_TOOL_STRIP
  const thumbnails = images.slice(0, TOOL_STRIP_IMAGE_LIMIT)
  return { thumbnails, images: images.map((item) => item.image), moreCount: images.length - thumbnails.length, chips }
}

/** Whether a strip has anything to show. */
export function hasToolStrip(strip: ToolStrip): boolean {
  return strip.images.length > 0 || strip.chips.length > 0
}
