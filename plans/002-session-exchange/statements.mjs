// Shared SQL for the disposable design proof and benchmark. One table.
// The host knows every reply route and consumed steer of a live turn in
// memory, so the hot path binds values directly: no INSERT SELECT, no joins.
const insertColumns = `message_id, actor_user_id, seat_user_id, kind, sender_session_id,
    recipient_session_id, reply_session_id, text, options_json, source_message_id,
    consumed_by_message_id, state, attempt_no, provider, execution_json, created_at, started_at, settled_at`

export const insertParameterCount = 18

export const sql = {
  // Any row written before or during a turn: a queued input, a routed turn
  // born running, a result owed to a session (queued, or born running when the
  // recipient is idle so delivery and wake are one write), a steer consumed by
  // a running turn, or a late wait registered on an unrouted running turn.
  insert: `INSERT INTO session_message (${insertColumns})
    VALUES (${Array(insertParameterCount).fill('?').join(', ')})
    ON CONFLICT (message_id) DO NOTHING
    RETURNING message_id`,
  // Retry path only: the primary key already existed.
  duplicate: `SELECT message_id, recipient_session_id, text, state FROM session_message
    WHERE message_id = ?`,
  // Final outcome of a turn someone depends on, in one statement: updates the
  // row written earlier, or inserts it when the first route joined through a
  // steer. A repeated terminal event changes nothing and returns no row.
  settle: `INSERT INTO session_message (message_id, actor_user_id, seat_user_id, kind,
      sender_session_id, recipient_session_id, reply_session_id, text, options_json,
      state, attempt_no, provider, execution_json, provider_thread_id, provider_turn_id,
      result_text, error_text, created_at, started_at, settled_at)
    VALUES (?, ?, ?, 'instruction', ?, ?, NULL, ?, '{}', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (message_id) DO UPDATE SET
      state = excluded.state, provider_thread_id = excluded.provider_thread_id,
      provider_turn_id = excluded.provider_turn_id, result_text = excluded.result_text,
      error_text = excluded.error_text, settled_at = excluded.settled_at
    WHERE session_message.state = 'running'
    RETURNING message_id`,
  // Start a queued row. Runs inside the settlement transaction of the turn
  // ahead of it, or alone when an idle session picks up a restored queue.
  dispatch: `UPDATE session_message
    SET state = 'running', attempt_no = attempt_no + 1, seat_user_id = ?, provider = ?, execution_json = ?, started_at = ?
    WHERE message_id = ? AND state = 'queued'
    RETURNING message_id, kind`,
  // A confirmed-safe retry (for example a rate-limit rejection) re-queues the
  // same row. No result is published for the abandoned attempt. Restart
  // recovery also uses it for a result row whose parent turn was killed.
  requeue: `UPDATE session_message SET state = 'queued', started_at = NULL, error_text = ?
    WHERE message_id = ? AND state = 'running'
    RETURNING message_id`,
  cancelQueued: `UPDATE session_message SET state = 'cancelled', settled_at = ?
    WHERE message_id = ? AND state = 'queued'
    RETURNING message_id`,
  cancelSessionQueue: `UPDATE session_message SET state = 'cancelled', settled_at = ?
    WHERE recipient_session_id = ? AND state = 'queued'
    RETURNING message_id`,
  // Boot only.
  recover: `SELECT m.message_id, m.recipient_session_id, m.kind, m.text, m.reply_session_id,
      m.source_message_id, m.state, m.attempt_no, m.actor_user_id, m.seat_user_id,
      m.provider, m.execution_json, m.created_at, m.started_at,
      source.result_text AS delivered_result, source.state AS source_state
    FROM session_message m
    LEFT JOIN session_message source ON source.message_id = m.source_message_id
    WHERE m.state IN ('queued', 'running')
    ORDER BY m.recipient_session_id, m.created_at, m.message_id`,
  // Boot only: wake routes of steers a killed turn had accepted.
  consumedRoutes: `SELECT DISTINCT reply_session_id FROM session_message
    WHERE consumed_by_message_id = ? AND reply_session_id IS NOT NULL`,
  // Card rehydration: the exchanges one session sent, newest last.
  sentBy: `SELECT message_id, recipient_session_id, text, state, result_text, error_text, created_at, settled_at
    FROM session_message WHERE sender_session_id = ? ORDER BY created_at, message_id`,
}
