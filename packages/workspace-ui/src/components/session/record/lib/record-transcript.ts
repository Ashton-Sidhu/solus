import type { Message, WorkMeta } from '@solus/contracts/types'
import { buildTurns, groupMessages, itemKey, type GroupedItem, type TurnEnd } from '../../../conversation/lib/turns'

/**
 * The item kinds a record draws. A record has no tab and no workspace, and a
 * share-link guest reads nothing but the session (sharing/share-manager.ts
 * `roleFor`): no work, no task, no host file. So it draws what the transcript
 * itself carries, and the cards whose subject lives elsewhere — review guides,
 * tasks, automations, browser captures, agent conversations — keep
 * their tool rows and nothing more.
 */
export const RECORD_ITEM_KINDS: ReadonlySet<GroupedItem['kind']> = new Set<GroupedItem['kind']>([
  'user', 'assistant', 'thought', 'question', 'tool-group', 'subagent-group', 'system',
  'plan', 'document', 'artifact',
])

export type RecordRow =
  | { kind: 'item'; key: string; item: GroupedItem }
  /** How a turn ended: failed, stopped, or no reply. */
  | { kind: 'end'; key: string; end: TurnEnd }

/**
 * One page of a record as rows, in transcript order. Turns are built as the
 * conversation builds them, so a turn's ending is named once — the notice and
 * an error echoed as prose are not drawn beside it — but nothing folds: a
 * record is read, not worked in.
 */
export function recordRows(messages: Message[]): RecordRow[] {
  const rows: RecordRow[] = []
  for (const turn of buildTurns(groupMessages(messages), { running: false })) {
    for (const item of [turn.lead, ...turn.body, ...turn.tail]) {
      if (item && drawsItem(item)) rows.push({ kind: 'item', key: itemKey(item), item })
    }
    if (turn.end) rows.push({ kind: 'end', key: `end-${turn.id}`, end: turn.end })
  }
  return rows
}

/** An activity row (a fork, a handoff) needs a tab to act on; with no text it
 *  shows nothing. A compaction divider needs no tab. */
function drawsItem(item: GroupedItem): boolean {
  if (!RECORD_ITEM_KINDS.has(item.kind)) return false
  return item.kind !== 'system' || !!item.message.content.trim() || !!item.message.compaction
}

/** An artifact's HTML travels in the transcript. An image is a file on the
 *  runner, which a record cannot read. */
export function artifactIsReadable(artifact: NonNullable<Message['artifact']>): boolean {
  return artifact.kind === 'html' && !!artifact.html
}

export interface RecordDocument {
  workId: string
  title: string
  workType: WorkMeta['type']
  contentVersion?: number
  /** The reader's works list holds it. A guest's never does: its link names
   *  the session, and a work needs a share of its own. */
  isReadable: boolean
}

/** The documents a turn wrote, named by the message when the reader cannot read the work. */
export function recordDocuments(messages: Message[], workFor: (workId: string) => Pick<WorkMeta, 'title' | 'type'> | undefined): RecordDocument[] {
  const documents: RecordDocument[] = []
  for (const message of messages) {
    const ref = message.workRef
    if (!ref?.workId) continue
    const work = workFor(ref.workId)
    documents.push({
      workId: ref.workId,
      title: work?.title ?? ref.title ?? 'Untitled document',
      workType: work?.type ?? ref.workType ?? 'doc',
      contentVersion: ref.contentVersion,
      isReadable: !!work,
    })
  }
  return documents
}
