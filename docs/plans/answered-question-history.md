# Answered questions in the conversation

Standard Claude and Codex questions remain visible after an answer is accepted.
The question and answer occupy one row outside collapsed tool activity and completed-turn folds. Choices are available through a keyboard-accessible disclosure.

The host broadcasts an accepted answer through the existing session event stream. Each client merges it into the corresponding question tool when present, or appends an in-memory row when the provider asked without a tool call. Replayed receipts do not duplicate the row. Empty answers from “Let the agent decide” retain that meaning. MCP authorization forms and URL requests keep their existing flow.

There is no new persistent store. Reload and boot use only existing provider transcript content. Question tool inputs stay available for the standalone row; existing tool-result text is exposed as a bounded excerpt in its details. Missing answers are labelled unavailable rather than inferred. A live receipt without provider transcript content may disappear on reload.

The shared conversation component serves Editor and Pill modes on desktop, web, and mobile. The host event uses the existing typed IPC/WebSocket event transport. Submitting returns focus to the active input where the client permits automatic focus.
