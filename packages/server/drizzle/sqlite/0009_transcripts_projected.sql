-- Mirrored transcript rows are now the projected row a client may see
-- (docs/plans/cloud-service-model.md §18): rows stored before this change hold
-- tool result bodies and are cleared; a runner re-sends every session it touches.
DELETE FROM `session_transcripts`;
