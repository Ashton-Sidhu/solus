// One row of a session's background work that the host keeps apart from the
// provider's own tasks: an MCP task or a resource watch
// (docs/plans/mcp-first-class.md §11.5, §12.5). The row reads only this shape,
// so a new kind adds a mapping, not a layout. Desktop, web, and mobile share it.

import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { HostApi } from './host-api'

/** `running` spins; `waiting` waits for news and does not move; `attention` asks the person; `ended`, `stopped`, and `failed` are past tense. */
export type BackgroundItemState = 'running' | 'waiting' | 'attention' | 'ended' | 'stopped' | 'failed'

export interface BackgroundItemAction {
  /** What the caller does when the person presses it. */
  id: string
  label: string
  /** The label while the action runs. */
  busyLabel: string
  /** Ends the work. The row shows it as its stop button, named by `BackgroundItem.stopLabel`. */
  stops?: boolean
}

export interface BackgroundItem {
  /** Stable across updates of one item. */
  key: string
  /** "<server> · <tool>" or "<server> · <resource>": the work, in a few words. */
  label: string
  /** Its state in a few words; plain text, maybe a server's own words. */
  detail: string
  state: BackgroundItemState
  /** For the time since the start, while the work runs; null once it ended. */
  startedAt: number | null
  actions: BackgroundItemAction[]
  /** What the stop button does, as its name and tooltip: "Stop watching <resource>", "Stop <tool>". */
  stopLabel: string
}

/** The fields a host keeps on each background record that the conversation shows. */
export interface BackgroundRecord {
  readonly id: string
  readonly sessionId: string
  readonly updatedAt: number
}

/** A host event that carries one changed record of a session. */
export type SessionRecordTopic = { [Name in HostEventName]: HostEventMap[Name] extends { sessionId: string } ? Name : never }[HostEventName]

/**
 * One kind of background record: how its row reads, whether its work is still
 * live, and how a client keeps a session's records current: the host's list,
 * then one `topic` event for each change.
 */
export interface BackgroundKind<T extends BackgroundRecord, Topic extends SessionRecordTopic = SessionRecordTopic> {
  item(record: T): BackgroundItem
  isLive(record: T): boolean
  list(api: HostApi, sessionId: string): Promise<T[]>
  readonly topic: Topic
  recordOf(event: HostEventMap[Topic]): T
}

/** Which rows the conversation shows: the live ones, and the ones that ended after `since` (the last turn's start). */
export function shownBackgroundRecords<T extends BackgroundRecord>(kind: BackgroundKind<T>, records: readonly T[], since: number): T[] {
  return records.filter((record) => kind.isLive(record) || record.updatedAt >= since)
}

/** The list with `record` in place of the record of its id, or at the end when the list has none. */
export function upsertById<T extends { readonly id: string }>(list: readonly T[], record: T): T[] {
  const index = list.findIndex((entry) => entry.id === record.id)
  return index === -1 ? [...list, record] : list.with(index, record)
}
