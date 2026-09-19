// Shared SQL for the disposable design proof and benchmark. One table.
const columns = `message_id, command_key, actor_user_id, request_fingerprint, kind, mode,
    sender_session_id, recipient_session_id, reply_session_id, text, options_json,
    source_message_id, state, attempt_no, seat_user_id, provider, execution_json, created_at, started_at`

export const sql = {
  // Idle target: the caller has serialized the session and knows no turn is
  // active, so the row is born running. The one-turn index rejects a race.
  acceptRunning: `INSERT INTO session_message (${columns})
    VALUES (?, ?, ?, ?, 'instruction', ?, ?, ?, ?, ?, '{}', NULL, 'running', 1, ?, ?, ?, ?, ?)
    ON CONFLICT (actor_user_id, command_key) DO NOTHING
    RETURNING message_id`,
  // Busy target: save the input now. It is dispatched inside the settlement
  // transaction of the turn ahead of it.
  acceptQueued: `INSERT INTO session_message (${columns})
    VALUES (?, ?, ?, ?, 'instruction', ?, ?, ?, ?, ?, '{}', NULL, 'queued', 0, NULL, NULL, NULL, ?, NULL)
    ON CONFLICT (actor_user_id, command_key) DO NOTHING
    RETURNING message_id`,
  duplicate: `SELECT message_id, request_fingerprint, state FROM session_message
    WHERE actor_user_id = ? AND command_key = ?`,
  // Start a turn for a queued row. Steer-only rows never become turns. A
  // question row is only dispatched while the turn that asked is still running.
  dispatch: `UPDATE session_message
    SET state = 'running', attempt_no = attempt_no + 1, seat_user_id = ?, provider = ?, execution_json = ?, started_at = ?
    WHERE message_id = ? AND state = 'queued' AND kind != 'answer' AND mode != 'steer'
      AND (kind != 'question' OR EXISTS (SELECT 1 FROM session_message asked
        WHERE asked.message_id = session_message.source_message_id AND asked.state = 'running'))
    RETURNING message_id, kind`,
  expireQuestion: `UPDATE session_message SET state = 'cancelled', error_text = 'stale', settled_at = ?
    WHERE message_id = ? AND kind = 'question' AND state = 'queued'
    RETURNING message_id`,
  // Final outcome of a turn: completed, failed or cancelled. Provider ids are
  // recorded here when the adapter reported them.
  settle: `UPDATE session_message
    SET state = ?, result_text = ?, error_text = ?, provider_thread_id = ?, provider_turn_id = ?, settled_at = ?
    WHERE message_id = ? AND state = 'running'
    RETURNING message_id`,
  // One result row per distinct reply session among the turn and every row it
  // consumed. Zero rows when nobody asked for a reply.
  reply: `INSERT INTO session_message (${columns})
    SELECT DISTINCT 'result:' || turn.message_id || ':' || waiting.reply_session_id,
      'result:' || turn.message_id || ':' || waiting.reply_session_id,
      turn.actor_user_id, 'result-of:' || turn.message_id, 'result', 'auto',
      turn.recipient_session_id, waiting.reply_session_id, NULL, NULL, '{}',
      turn.message_id, 'queued', 0, NULL, NULL, NULL, ?, NULL
    FROM session_message turn
    JOIN session_message waiting
      ON waiting.message_id = turn.message_id OR waiting.consumed_by_message_id = turn.message_id
    WHERE turn.message_id = ? AND turn.state IN ('completed', 'failed', 'cancelled')
      AND waiting.reply_session_id IS NOT NULL
    RETURNING message_id, recipient_session_id`,
  // A confirmed-safe retry (for example a rate-limit rejection) re-queues the
  // same row. No result row is published for the abandoned attempt.
  requeue: `UPDATE session_message
    SET state = 'queued', started_at = NULL, error_text = ?
    WHERE message_id = ? AND state = 'running'
    RETURNING message_id`,
  // Question: notify the parent of a running turn. Zero rows without a route.
  question: `INSERT INTO session_message (${columns})
    SELECT 'question:' || ?, 'question:' || ?, asked.actor_user_id, 'question:' || ?, 'question', 'auto',
      asked.recipient_session_id, asked.reply_session_id, NULL, ?, ?, asked.message_id, 'queued', 0, NULL, NULL, NULL, ?, NULL
    FROM session_message asked
    WHERE asked.message_id = ? AND asked.state = 'running' AND asked.reply_session_id IS NOT NULL
    ON CONFLICT (actor_user_id, command_key) DO NOTHING
    RETURNING message_id`,
  // Answer from any surface: saved before the provider responder is called.
  answer: `INSERT INTO session_message (${columns})
    VALUES (?, ?, ?, ?, 'answer', 'auto', ?, ?, NULL, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, NULL)
    ON CONFLICT (actor_user_id, command_key) DO NOTHING
    RETURNING message_id`,
  // Steering input or an answer was accepted by the recipient's running turn.
  consume: `UPDATE session_message
    SET state = 'consumed', settled_at = ?, consumed_by_message_id = (
      SELECT turn.message_id FROM session_message turn
      WHERE turn.recipient_session_id = session_message.recipient_session_id AND turn.state = 'running')
    WHERE message_id = ? AND state = 'queued' AND kind IN ('instruction', 'answer')
      AND EXISTS (SELECT 1 FROM session_message turn
        WHERE turn.recipient_session_id = session_message.recipient_session_id AND turn.state = 'running')
    RETURNING message_id, consumed_by_message_id`,
  // An input that could not be delivered: steer-only with no running turn, or
  // an answer the provider no longer accepts.
  fail: `UPDATE session_message SET state = 'failed', error_text = ?, settled_at = ?
    WHERE message_id = ? AND state = 'queued'
    RETURNING message_id`,
  cancelQueued: `UPDATE session_message SET state = 'cancelled', settled_at = ?
    WHERE message_id = ? AND state = 'queued'
    RETURNING message_id`,
  cancelSessionQueue: `UPDATE session_message SET state = 'cancelled', settled_at = ?
    WHERE recipient_session_id = ? AND state = 'queued'
    RETURNING message_id`,
  // Restart: an answer that was in flight can never be confirmed.
  failStaleAnswers: `UPDATE session_message SET state = 'failed', error_text = 'stale', settled_at = ?
    WHERE kind = 'answer' AND state = 'queued'
    RETURNING message_id`,
  recover: `SELECT m.message_id, m.recipient_session_id, m.kind, m.mode, m.text, m.options_json,
      m.reply_session_id, m.source_message_id, m.state, m.attempt_no, m.actor_user_id,
      m.seat_user_id, m.provider, m.execution_json, m.provider_thread_id, m.provider_turn_id,
      source.state AS source_state, source.result_text AS delivered_result
    FROM session_message m
    LEFT JOIN session_message source ON source.message_id = m.source_message_id
    WHERE m.state IN ('queued', 'running')
    ORDER BY m.recipient_session_id, m.created_at, m.message_id`,
}
