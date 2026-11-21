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
  /** Shared word normalization, indexed without stemming by either engine. */
  search_text: text({ notNull: true, default: '' }),
  updated_at: bigint({ notNull: true }),
}, {
  // Session ids are unique on their own: leading with one lets a read that
  // spans every organization seek a session's rows too.
  primaryKey: ['session_id', 'position', 'organization_id'],
  // The rows whose search text is still to be derived (`db/session-search-rebuild.ts`).
  indexes: [{ name: 'session_transcripts_search_pending', columns: ['session_id'], where: "search_text = ''" }],
})

/**
 * The code changes of one ended turn, as its runner mirrored them (`turn-diff`
 * items). It is the only copy of a turn's diff that a reader with no host
 * online can read. `patch` is null when the patch was over the limit; the
 * counts stay. `organization_id` is the mirror scope of the session, as in
 * `session_transcripts`. `ended_at` joins the diff to its turn by time.
 */
export const sessionTurnDiffs = defineTable('session_turn_diffs', {
  organization_id: text({ notNull: true }),
  session_id: text({ notNull: true }),
  turn_index: integer({ notNull: true }),
  runner_host_id: text({ notNull: true }),
  ended_at: bigint({ notNull: true }),
  files_changed: integer({ notNull: true }),
  additions: integer({ notNull: true }),
  deletions: integer({ notNull: true }),
  patch: text(),
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['session_id', 'turn_index', 'organization_id'],
})
