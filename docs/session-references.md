# Session references

A session reference is a chip in the prompt that names another session. When
you send the prompt, the agent gets the session's id and reads the session with
`read_session`. The chip does not copy the transcript into the prompt.

## Add a reference

On desktop and web:

- **Drag** a session row from the sidebar onto the input bar. The chip goes
  where you drop it. A drop beside the text puts it at the end. While the drag
  is over the input bar, a dashed outline shows where it lands. If you selected
  more than one row, drag one of the selected rows to add a chip for each.
- **Keyboard or touch:** open the row's menu (right-click, or long-press on a
  touch screen) and choose **Reference in Prompt**. The chip goes at the caret
  of the input bar that has the keyboard. The menu does not show this item for
  the session that is on screen.
- **Type `#`** in the input bar and choose **Sessions**.

On mobile, tap **+** in the thread composer and choose **Reference Session…**.
Search for a session on the same host and tap it. The reference goes in at the
caret as text; the mobile composer does not show chips. The list has only the
sessions that the phone has loaded.

After a drop or a menu choice, the caret is in the input bar, after the chip.

A session that has not started (it has no first turn yet) cannot be referenced:
its host has no record for the agent to read.

## The format

The chip is the text `[title](session://ref?sessionId=…&provider=…&cwd=…&serverId=…)`
(`sessionReferenceMarkdown` in `packages/contracts/src/session-link.ts`). The
session id and its host id go with it, so a reference works over a remote
connection and for a session on another host. A drag also carries the
`application/x-solus-session-refs` type for Solus, and a `session://ref` URI
and the markdown text for other apps. A file drop on the input bar still adds
an attachment.
