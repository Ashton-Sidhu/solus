import type { Message, ToolResultAudio, ToolResultImage } from '@solus/contracts/types'
import { toolServerName } from './mcp-tool-label'

/**
 * Where a tool call's visible outputs show in a conversation, on desktop, web,
 * and mobile (docs/transcript-cards.md, "Tool outputs").
 *
 * Folded rows can show chips for audio and left-out notes. Tool images show
 * in the open tool details. The turn's image gallery holds the final output.
 */
export type ToolOutputPlace = 'strip' | 'tool-detail' | 'outside-fold'

/** The fields of a tool call's message that say what the call is, not what it gave back. */
export const TOOL_CALL_FACTS = ['toolName', 'toolId', 'toolInput', 'toolStatus', 'toolCompletedAt'] as const

/** Every field a tool call's message carries for the person to see. */
export type ToolOutputField = Exclude<Extract<keyof Message, `tool${string}`>, (typeof TOOL_CALL_FACTS)[number]> | 'errorHead'

export const TOOL_OUTPUT_PLACES = {
  toolImages: 'tool-detail',
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

/** A chip opens the folds down to the tool line of `toolId`. */
export type ToolStripChip =
  | { readonly kind: 'audio'; readonly key: string; readonly toolId: string; readonly server: string; readonly format: string }
  | { readonly kind: 'left-out'; readonly key: string; readonly toolId: string; readonly count: number }

type FieldsIn<Place extends ToolOutputPlace> = {
  [Field in ToolOutputField]: (typeof TOOL_OUTPUT_PLACES)[Field] extends Place ? Field : never
}[ToolOutputField]

/** One item maker for each strip field: a field moved to the strip does not type check without one. */
const STRIP_ITEMS: { readonly [Field in FieldsIn<'strip'>]: (tool: ToolCallOutputs) => ToolStripChip[] } = {
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

/** One clip that an open tool line plays, with its label: "Audio 1 · MP3". */
export interface OpenLineAudio {
  readonly audio: ToolResultAudio
  readonly label: string
}

/** The audio an open tool line plays. A call still running has none yet. */
export function openLineAudio(tool: ToolCallOutputs): OpenLineAudio[] {
  if (tool.toolStatus === 'running') return []
  return (tool.toolAudio ?? []).map((audio, index) => ({ audio, label: `Audio ${index + 1} · ${audioFormat(audio)}` }))
}

/** What the host left out of the call's result, with the limit, as the agent read it. A call still running has none yet. */
export function openLineLeftOut(tool: ToolCallOutputs): readonly string[] {
  return tool.toolStatus === 'running' ? [] : tool.toolLeftOut ?? []
}

/** The outputs strip of a folded row. */
export interface ToolStrip {
  /** The audio and left-out chips, in call order. */
  readonly chips: readonly ToolStripChip[]
}

export const EMPTY_TOOL_STRIP: ToolStrip = { chips: [] }

const STRIP_FIELDS = Object.keys(STRIP_ITEMS) as FieldsIn<'strip'>[]

/** The outputs strip of a folded row, from the calls it folds. A running call gives nothing. */
export function toolStrip(tools: readonly ToolCallOutputs[]): ToolStrip {
  const chips = tools.flatMap((tool) =>
    tool.toolStatus === 'running' ? [] : STRIP_FIELDS.flatMap((field) => STRIP_ITEMS[field](tool)),
  )
  return chips.length > 0 ? { chips } : EMPTY_TOOL_STRIP
}

/** Whether a strip has anything to show. */
export function hasToolStrip(strip: ToolStrip): boolean {
  return strip.chips.length > 0
}
