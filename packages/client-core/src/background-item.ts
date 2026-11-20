// One row of a session's background work that the host keeps apart from the
// provider's own tasks: an MCP task today, a resource watch later
// (docs/plans/mcp-first-class.md §11.5, §12.5). The row reads only this shape,
// so a new kind adds a mapping, not a layout. Desktop, web, and mobile share it.

/** `running` spins; `attention` asks the person; `ended` and `failed` are past tense. */
export type BackgroundItemState = 'running' | 'attention' | 'ended' | 'failed'

export interface BackgroundItemAction {
  /** What the caller does when the person presses it. */
  id: string
  label: string
  /** The label while the action runs. */
  busyLabel: string
}

export interface BackgroundItem {
  /** Stable across updates of one item. */
  key: string
  /** "<server> · <tool>": the work, in a few words. */
  label: string
  /** Its state in a few words; plain text, maybe a server's own words. */
  detail: string
  state: BackgroundItemState
  /** For the time since the start, while the work runs; null once it ended. */
  startedAt: number | null
  actions: BackgroundItemAction[]
}
