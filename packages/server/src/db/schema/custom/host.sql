-- The transcript search index on this host (packages/server/src/db/session-indexer.ts):
-- a contentless FTS5 table over `session_messages`, written by the indexer beside
-- each message row. Contentless so a delete needs only the rowid.
CREATE VIRTUAL TABLE session_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');
