import type { ToolProgress, ToolResultAudio, ToolResultImage } from '@solus/contracts/types'
import type { SecretOutcomeRecord } from '@solus/contracts/secret-request'
import type { TranscriptModel } from './transcript-model'

/** One tool call as the native transcript keeps it: the tool row of the feed. */
export interface ToolItem {
  kind: 'tool'
  id: string
  toolInputKey?: string
  viewedImagePath?: string
  timestamp?: number
  toolId: string
  toolName: string
  input: string | null
  status: 'running' | 'completed' | 'error'
  errorHead: string | null
  /** Rows a sub-agent wrote under this call. Shown as a count. */
  childCount: number
  /** A provider-native subagent this call ran ('claude', 'codex', …): it has
   *  no Solus session to open, so it shows as an agent card of its own. */
  subagent: string | null
  /** The subagent's answer, apart from ordinary tool output. */
  report: string | null
  completedAt?: number
  /** Pictures the call returned, stored on the host. */
  images?: readonly ToolResultImage[]
  /** The tool a background sub-agent ran last (`background_task_progress`),
   *  when its own rows do not reach this client. Live only. */
  lastToolName?: string
  /** The latest progress a running MCP call reported. Live only: history never has it. */
  progress?: ToolProgress
  /** Audio the call returned, stored on the host. */
  audio?: readonly ToolResultAudio[]
  /** What the host left out of the call's result, with the limit. */
  leftOut?: readonly string[]
  /** A `request_secret` call's outcomes: its label after the card closes. */
  secretOutcomes?: SecretOutcomeRecord[]
  /** The provider child's own transcript, kept off the parent's feed. */
  children?: TranscriptModel
}

/** A provider can reuse a call ID. Only ambiguous IDs need an ordered search. */
export class ToolRowIndex {
  private readonly toolRows = new Map<string, string | null>()

  add(toolId: string, rowId: string): void {
    const prior = this.toolRows.get(toolId)
    this.toolRows.set(toolId, prior === undefined || prior === rowId ? rowId : null)
  }

  /** The newest tool item for a provider tool id; `runningOnly` for in-flight updates. */
  find(model: Pick<TranscriptModel, 'order' | 'items'>, toolId: string, runningOnly = false): string | undefined {
    const rowId = this.toolRows.get(toolId)
    if (rowId === undefined) return undefined
    if (rowId !== null) {
      const item = model.items.get(rowId)
      return item?.kind === 'tool' && item.toolId === toolId && (!runningOnly || item.status === 'running') ? rowId : undefined
    }
    for (let index = model.order.length - 1; index >= 0; index -= 1) {
      const id = model.order[index]
      const item = id ? model.items.get(id) : undefined
      if (item?.kind === 'tool' && item.toolId === toolId && (!runningOnly || item.status === 'running')) return id
    }
    for (const [id, item] of model.items) {
      if (item.kind === 'tool' && item.toolId === toolId && (!runningOnly || item.status === 'running')) return id
    }
    return undefined
  }
}
