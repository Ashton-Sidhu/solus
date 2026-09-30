import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * The mirrored transcript table on the collaboration plane
 * (docs/plans/cloud-service-model.md §6). A runner appends what it produces to
 * its local mirror log and ships it in order; this is where transcript rows
 * land on the workspace service — and, on a signed-out host, where nothing
 * lands, because a host reads its own transcript files directly. Every row
 * names its organization and the runner it came from.
 *
 * One history row of a session's transcript, as the runner's reader produced
 * it: a `SessionLoadMessage` at its position. A position is written again when
 * the row changed (a tool call that finished after its row was first
 * mirrored), so the key is the position and the payload is the latest.
 */
export const sessionTranscripts = defineTable('session_transcripts', {
  organization_id: text({ notNull: true, default: 'local' }),
  session_id: text({ notNull: true }),
  position: integer({ notNull: true }),
  runner_host_id: text({ notNull: true }),
  message: json({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, {
  // Session ids are unique on their own: leading with one lets a read that
  // spans every organization seek a session's rows too.
  primaryKey: ['session_id', 'position', 'organization_id'],
})
