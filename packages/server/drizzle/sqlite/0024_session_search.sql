ALTER TABLE `session_transcripts` ADD `search_text` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX session_transcripts_search_pending ON session_transcripts(session_id) WHERE search_text = '';
--> statement-breakpoint
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
