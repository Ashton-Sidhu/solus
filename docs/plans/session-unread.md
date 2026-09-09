# Session unread state

A conversation becomes read when it is visible in the foreground client. Returning
focus to an open conversation, closing a page that covers it, expanding Pill mode,
and revealing a companion pane must clear its unread flag without another tab selection.
Every tab for that session is marked read together. Hidden conversations retain unread
state. Mobile does not count retained companion panes that it does not display.

The shared workspace observes the client shell and pane visibility. This applies to
desktop, web, and mobile, for both providers and local or remote hosts. It changes the
existing tab flags in place; no transcript or server contract changes are needed.
