import { hostPathBaseName } from '@solus/contracts/host-path'
import type { ToolResultAudio } from '@solus/contracts/types'
import { ASSET_ID } from './asset-paths'
import { audioAssetMime } from './assets'

/**
 * The lines a tool result's text carries for content the agent cannot take
 * whole (docs/plans/mcp-first-class.md §6): one for each saved audio file, and
 * one for each part left out by a limit. The agent reads them as text. The
 * provider keeps that text in its own transcript, so the host reads the same
 * lines back, live and on a history reload, to give the person a player and
 * the notes. A client never receives the tool's text, only these fields.
 */

/** A tool row shows at most this many players, and at most this many notes. */
export const MAX_TOOL_RESULT_AUDIO = 8
export const MAX_TOOL_RESULT_LEFT_OUT = 8
/** A note longer than this is not one the host wrote. */
const MAX_LEFT_OUT_LENGTH = 600

const AUDIO_LINE = /^\[Audio: [^,\]\n]+, [^,\]\n]+, saved at ([^\]\n]+)\]$/gm
const LEFT_OUT_LINE = /^\[Left out: ([^\n]+)\]$/gm

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

/** The line for one saved audio file. The path's leaf is the asset id. */
export function audioLine(mimeType: string, bytes: number, hostPath: string): string {
  return `[Audio: ${mimeType}, ${formatByteSize(bytes)}, saved at ${hostPath}]`
}

/** The line for one part left out, with the limit or the check that left it out. */
export function leftOutLine(reason: string): string {
  return `[Left out: ${reason}]`
}

/** What a tool row shows of a result beside its images. */
export interface ToolResultMedia {
  toolAudio?: ToolResultAudio[]
  toolLeftOut?: string[]
}

/**
 * The audio and the notes a tool result's text names. Only a stored asset id
 * with an audio extension becomes a player: a line a server wrote itself can
 * name only bytes it already has, and the asset read refuses a missing file.
 */
export function toolResultMedia(text: string): ToolResultMedia {
  const media: ToolResultMedia = {}
  if (text.includes('[Audio: ')) {
    const audio = new Map<string, ToolResultAudio>()
    for (const match of text.matchAll(AUDIO_LINE)) {
      if (audio.size >= MAX_TOOL_RESULT_AUDIO) break
      const assetId = hostPathBaseName(match[1].trim())
      const mimeType = ASSET_ID.test(assetId) ? audioAssetMime(assetId) : null
      if (mimeType) audio.set(assetId, { assetId, mimeType })
    }
    if (audio.size) media.toolAudio = [...audio.values()]
  }
  if (text.includes('[Left out: ')) {
    const notes: string[] = []
    for (const match of text.matchAll(LEFT_OUT_LINE)) {
      if (notes.length >= MAX_TOOL_RESULT_LEFT_OUT) break
      // The host path is the agent's; a client gets no host path.
      if (match[1].length <= MAX_LEFT_OUT_LENGTH) notes.push(match[1].replace(/ Saved at [^\n]+$/, ' The agent can read the saved file on the host.'))
    }
    if (notes.length) media.toolLeftOut = notes
  }
  return media
}
