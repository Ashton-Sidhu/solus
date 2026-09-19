-- The works search index on SQLite (packages/server/src/db/search-index.ts):
-- an FTS5 table keyed by work_id and kept in step by triggers. Standalone on
-- purpose (not content='works'): works.id is a TEXT primary key, so the works
-- rowid is implicit and not guaranteed stable. A host whose hand-written
-- migrations already made these keeps them; IF NOT EXISTS leaves them alone.
CREATE VIRTUAL TABLE IF NOT EXISTS works_fts USING fts5(
  work_id UNINDEXED,
  title,
  content,
  tokenize='porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS works_fts_ai AFTER INSERT ON works BEGIN
  INSERT INTO works_fts(work_id, title, content)
    VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.content, ''));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS works_fts_ad AFTER DELETE ON works BEGIN
  DELETE FROM works_fts WHERE work_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS works_fts_au AFTER UPDATE ON works BEGIN
  DELETE FROM works_fts WHERE work_id = old.id;
  INSERT INTO works_fts(work_id, title, content)
    VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.content, ''));
END;
