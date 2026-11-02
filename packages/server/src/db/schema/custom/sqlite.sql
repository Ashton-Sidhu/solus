-- The works search index on SQLite (packages/server/src/db/search-index.ts):
-- an FTS5 table kept in step by triggers on `works`. `works.id` is text and its
-- implicit rowid can change when a migration rebuilds the table, so
-- `works_fts_rows` gives each work a stable integer that is its FTS rowid. A
-- trigger then finds a work's FTS row by key, not by scanning the index. A
-- migration that rebuilds `works` drops these triggers with the old table and
-- must create them again.
CREATE TABLE `works_fts_rows` (
	`rowid` integer PRIMARY KEY,
	`work_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE VIRTUAL TABLE works_fts USING fts5(
  title,
  content,
  tokenize='porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER works_fts_ai AFTER INSERT ON works BEGIN
  INSERT INTO works_fts_rows(work_id) VALUES (new.id);
  INSERT INTO works_fts(rowid, title, content)
    VALUES ((SELECT rowid FROM works_fts_rows WHERE work_id = new.id), COALESCE(new.title, ''), COALESCE(new.content, ''));
END;
--> statement-breakpoint
CREATE TRIGGER works_fts_ad AFTER DELETE ON works BEGIN
  DELETE FROM works_fts WHERE rowid = (SELECT rowid FROM works_fts_rows WHERE work_id = old.id);
  DELETE FROM works_fts_rows WHERE work_id = old.id;
END;
--> statement-breakpoint
-- Only a change to the indexed text re-indexes: pins, metadata and version
-- bumps write `works` often and leave the index alone.
CREATE TRIGGER works_fts_au AFTER UPDATE OF title, content ON works
WHEN old.title IS NOT new.title OR old.content IS NOT new.content BEGIN
  UPDATE works_fts SET title = COALESCE(new.title, ''), content = COALESCE(new.content, '')
    WHERE rowid = (SELECT rowid FROM works_fts_rows WHERE work_id = new.id);
END;
--> statement-breakpoint
-- The session search index on SQLite (packages/server/src/db/session-search.ts): an FTS5
-- table over each mirrored message's `search_text`, kept in step by triggers.
CREATE VIRTUAL TABLE session_transcripts_fts USING fts5(search_text, content='session_transcripts', content_rowid='rowid', tokenize='unicode61');
--> statement-breakpoint
CREATE TRIGGER session_transcripts_search_insert AFTER INSERT ON session_transcripts BEGIN
  INSERT INTO session_transcripts_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER session_transcripts_search_update AFTER UPDATE OF search_text ON session_transcripts WHEN old.search_text IS NOT new.search_text BEGIN
  INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO session_transcripts_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER session_transcripts_search_delete AFTER DELETE ON session_transcripts BEGIN
  INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;
