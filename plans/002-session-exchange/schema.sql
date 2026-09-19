-- Design proof only. Never execute this file against an existing Solus database.
-- One table. Every row is one input addressed to one session. The row that
-- runs a turn is also the turn ledger entry for that turn (replacing the
-- existing session_turn shape); rows that are consumed by a running turn
-- (steer, answer) or that wait in a queue (result, question) share the table.
CREATE TABLE session_message (
  message_id TEXT PRIMARY KEY,
  command_key TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('instruction', 'result', 'question', 'answer')),
  -- auto: steer when the target is running, otherwise queue. queue: never
  -- steer. steer: fail unless the target is running. Only instructions choose.
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'queue', 'steer')),
  sender_session_id TEXT,
  recipient_session_id TEXT NOT NULL,
  reply_session_id TEXT,
  text TEXT,
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  -- result: the settled turn it reports. question: the running turn that
  -- asked. answer: the question row, when one was routed to an agent.
  source_message_id TEXT REFERENCES session_message(message_id),
  -- Set when a running turn accepted this row as steering input or an answer.
  consumed_by_message_id TEXT REFERENCES session_message(message_id),
  -- running covers launch intent through settlement. A running row found at
  -- restart with no live handle is uncertain and is reconciled, never relaunched.
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'consumed', 'completed', 'failed', 'cancelled'
  )),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  seat_user_id TEXT,
  provider TEXT,
  execution_json TEXT CHECK (execution_json IS NULL OR json_valid(execution_json)),
  -- Recorded at settlement when the adapter reports them; no separate write.
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  result_text TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  settled_at INTEGER,
  UNIQUE (actor_user_id, command_key),
  CHECK (kind != 'result' OR (text IS NULL AND source_message_id IS NOT NULL AND reply_session_id IS NULL)),
  CHECK (kind != 'question' OR (source_message_id IS NOT NULL AND reply_session_id IS NULL)),
  CHECK (kind != 'answer' OR (reply_session_id IS NULL AND state IN ('queued', 'consumed', 'failed'))),
  CHECK (state != 'consumed' OR consumed_by_message_id IS NOT NULL),
  CHECK (state NOT IN ('consumed', 'completed', 'failed', 'cancelled') OR settled_at IS NOT NULL),
  CHECK (state != 'running' OR (attempt_no > 0 AND provider IS NOT NULL AND started_at IS NOT NULL))
);

-- Recovery reads only unfinished rows, in queue order per session.
CREATE INDEX message_unfinished
  ON session_message(recipient_session_id, created_at, message_id)
  WHERE state IN ('queued', 'running');
-- One turn per session. Answers are delivered into a running turn, so they
-- are never turns.
CREATE UNIQUE INDEX message_one_turn_per_session ON session_message(recipient_session_id)
  WHERE state = 'running';
-- Result fan-out at settlement reads the rows a turn consumed.
CREATE INDEX message_consumed_by ON session_message(consumed_by_message_id)
  WHERE consumed_by_message_id IS NOT NULL;
-- Seat usage attribution, as the existing ledger has today.
CREATE INDEX message_by_seat ON session_message(seat_user_id, created_at)
  WHERE seat_user_id IS NOT NULL;

-- No triggers, generic event log, receipt table, inbox table, or outbox table.
-- A result row IS the parent's durable input; its payload lives on the source
-- row's result_text and is not copied.
