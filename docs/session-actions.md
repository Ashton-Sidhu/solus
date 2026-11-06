# Session actions

The session action row sits centred on the top edge of the input bar in desktop
and web. The icons do not move when you point at them. When the input bar collapses (the keyboard is
elsewhere and "collapse when idle" is on), the row fades out with it and comes
back when the bar expands; it stays while you point at it or focus is in it.
It replaced the action orb: the actions are always visible, so no action needs a
click to reveal the others first.

## The row

- **Plan progress.** When the agent keeps a todo list, the row starts with a
  progress ring. Point at it to see the steps.
- **Icons.** Pin, changed files (desktop), terminal (desktop), fork, continue in a
  new worktree, insights, and review. Review shows when the session has changed
  files; its tooltip reads **Review N files**, **Reviewing…**, or **Open review**.
  All icons are the same size. Point at one or move focus to it to show a tooltip
  with its name and shortcut, or, for a disabled action, the reason. The star
  fills when the session is pinned, and the review icon takes the accent colour
  while a review runs or is ready. On a touch screen the tooltips do not show.

## The action list

Press **⌥⇧Q** (the shortcut is in Settings → Keybindings as "Open session
actions") to replace the row with a list of every action, including regenerate
or cancel review. Type to filter, use ↑ and ↓ to move, press Enter to run, and press Esc
to go back to the prompt. The draft in the input bar does not change.

## Stop

While a turn runs and the input bar is empty, the Send button is a Stop button on
every device. When you type, it becomes Send or Steer again. ⌃C also stops the
turn.

## Mobile

The mobile app does not have the row or the action list yet. It has a Stop button
in its composer.
