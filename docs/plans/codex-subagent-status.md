# Codex subagent status

The Subagents section counts agent card states in the session transcript. A
Codex `subAgentActivity` start record establishes the child identity, but does
not establish whether the child is still running when history is loaded.

Successful child turn completion settles the originating card with its final
answer. Failed and interrupted child turns settle it as an error. These events
must not complete the parent session's turn.
A later child turn start marks the same card as running again.

When opening history, the server reads the latest turn summary for each child
represented in the requested message window. Completed turns restore completed
cards; a later turn in progress keeps the card running. Reads are deduplicated
by child thread and limited to four concurrent requests. An unavailable child
leaves the known card state intact and does not prevent loading the parent.

This is shared server behavior for desktop, web, and mobile, in both workspace
modes and local or remote connections. Claude uses its existing lifecycle path.
