-- Design proof only. Never execute this file against an existing Solus database.
-- One table. Every row is one input addressed to one session.
--
-- Write rule: a row is written only when a party other than the turn's author
-- depends on it (a queued input, a sender waiting for a result, a card that
-- must rehydrate). Every other turn writes nothing: its prompt and reply live in
-- the provider transcript. No provider turn outlives the host process: both providers are
-- non-detached children driven over stdio, so anything that only matters while
-- a turn runs (questions, answers, unrouted steers) is never persisted.
CREATE TABLE session_message (
  -- The command's own id: a client prompt id, `<sender>:<tool call id>`, or a
  -- host UUID. Re-sending the same id conflicts on the primary key.
  message_id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  -- The seat a queued row runs under when it starts, possibly after a restart.
  seat_user_id TEXT,
  -- instruction: typed, card, tool or automation input. result: a settled
  -- turn's outcome owed to reply_session_id's session. question: a turn that a
  -- child's question woke (written at settlement only; the question itself is
  -- never persisted).
  kind TEXT NOT NULL CHECK (kind IN ('instruction', 'result', 'question')),
  -- The session that sent this input, when one did (an agent tool or a card in
  -- that session's transcript). Cards rehydrate from rows by sender.
  sender_session_id TEXT,
  recipient_session_id TEXT NOT NULL,
  -- Wake route: the session that receives a result row when this settles.
  -- NULL when nobody asked to be woken (a card send shows the outcome without
  -- waking the model).
  reply_session_id TEXT,
  text TEXT,
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
  -- result/question: the turn row that produced it.
  source_message_id TEXT REFERENCES session_message(message_id),
  -- Steering input accepted by a running turn. No foreign key: an unrouted
  -- turn has no row until it settles.
  consumed_by_message_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'consumed', 'completed', 'failed', 'cancelled'
  )),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  provider TEXT,
  execution_json TEXT CHECK (execution_json IS NULL OR json_valid(execution_json)),
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  result_text TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  settled_at INTEGER,
  CHECK (kind != 'result' OR (text IS NULL AND source_message_id IS NOT NULL AND reply_session_id IS NULL)),
  CHECK (kind != 'question' OR source_message_id IS NOT NULL),
  CHECK (state != 'consumed' OR consumed_by_message_id IS NOT NULL),
  CHECK (state NOT IN ('consumed', 'completed', 'failed', 'cancelled') OR settled_at IS NOT NULL),
  CHECK (state NOT IN ('running', 'completed', 'failed') OR (attempt_no > 0 AND provider IS NOT NULL AND started_at IS NOT NULL))
);

-- Recovery reads only unfinished rows, in queue order per session. Rows
-- inserted already settled never enter this index.
CREATE INDEX message_unfinished
  ON session_message(recipient_session_id, created_at, message_id)
  WHERE state IN ('queued', 'running');
-- Safety net behind the host's per-session owner: one persisted running turn.
CREATE UNIQUE INDEX message_one_turn_per_session ON session_message(recipient_session_id)
  WHERE state = 'running';
-- Restart recovery finds the steers a killed turn had accepted.
CREATE INDEX message_consumed_by ON session_message(consumed_by_message_id)
  WHERE consumed_by_message_id IS NOT NULL;
-- Card rehydration: the exchanges a session sent.
CREATE INDEX message_by_sender ON session_message(sender_session_id, created_at)
  WHERE sender_session_id IS NOT NULL;

-- No triggers, generic event log, receipt table, inbox table, or outbox table.
-- A result row IS the parent's durable input; its payload lives on the source
-- row's result_text and is not copied.
