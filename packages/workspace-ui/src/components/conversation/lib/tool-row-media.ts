import type { Message, ToolResultAudio } from '@solus/contracts/types'

export interface ToolRowAudio {
  audio: ToolResultAudio
  label: string
}

/** The audio an open tool row plays. A call still running has none yet. */
export function toolRowAudio(tool: Message): ToolRowAudio[] {
  if (tool.toolStatus === 'running') return []
  return (tool.toolAudio ?? []).map((audio, index) => ({
    audio,
    label: `Audio ${index + 1} · ${audio.assetId.slice(audio.assetId.lastIndexOf('.') + 1).toUpperCase()}`,
  }))
}

/** What the host left out of the call's result, with the limit, as the agent read it. */
export function toolRowLeftOut(tool: Message): string[] {
  return tool.toolStatus === 'running' ? [] : tool.toolLeftOut ?? []
}
