# Tasks

A task in Solus is an item of work that GitHub or Jira owns: a GitHub issue, a
draft item of a GitHub Project, or a Jira issue. Solus has no task of its own.
It reads tasks from your task sources, sends each change to the provider, and
adds only its own attachments. Tasks belong to no project. The design is in
[Provider-owned tasks](plans/provider-owned-tasks.md).

## Words

- **Task source.** One place you read tasks from. There are four kinds:
  a GitHub repository, a GitHub Project, a Jira project, and a Jira board.
- **Board.** A GitHub Project or a Jira board: a task source that has columns
  of its own.
- **Column.** A status grouping that the source owns: a Status option of a
  GitHub Project, a column of a Jira board, `Open` and `Closed` of a
  repository, a workflow status of a Jira project. Solus shows the provider's
  names in the provider's order.
- **Status category.** `Open`, `Active` or `Done`. This is the one coarse fact
  that Solus derives from a column, for views that mix sources and for agent
  rules.
- **Default source.** The task source where a new task is created.
- **Attachment.** Data that Solus owns about a task. The provider never hears
  of it.

## Task sources

Your task sources are yours, not a project's. They are in your personal
settings (`taskSources`), which sync with your account,
so each of your clients shows the same sources. You can have many task
sources, and you can mix GitHub and Jira. With no task source you have no
tasks: the Tasks page then shows the source setup.

A task belongs to no project. A task that two of your sources list shows one
time in the **All sources** view, and in each source's own view with that
source's column.

The client sends your sources to the host with each read of the Tasks page,
and with each prompt in the execution preferences, so an agent on the host
uses the same sources. The host reads each source with your own provider
connection. Two people on one host who read one source cause one provider
read, but each person sees the tasks only after their own connection read
the source.

### Add a source

Open the Tasks page. With no source, the page shows **Add a task source**.
With sources, use **Add source** at the end of the row of sources, above the
search field. You do not choose a project first. The control lists what your
connections offer:

- the GitHub repositories that you pushed to most recently (at most 50);
- the GitHub Projects that your GitHub connection can see;
- the Jira projects and the Jira boards of the connected Atlassian site.

A kind that offers nothing says why, for example "Connect GitHub in Settings
first".

To add a source that the list does not show, type or paste it into the search
field of the control:

- `owner/repo`, or the URL of a repository (`https://github.com/owner/repo`);
- the URL of a GitHub Project
  (`https://github.com/orgs/<owner>/projects/<n>` or
  `https://github.com/users/<owner>/projects/<n>`).

Solus takes sources from `github.com` only. It refuses the URL of an issue, a
pull request or a file, because that names one item and not a source. Solus
does not check a typed source when you add it. The host reads the source
immediately after, and a wrong name then shows **No access** on the source's
chip.

The sources are saved in your personal settings. Another person who uses the
same project or host has their own sources.

A project config (`.solus/config.json`) from before has `taskSources` and
`defaultTaskSource`. Solus ignores them now: add those sources again on the
Tasks page.

### Remove a source

Each source is a chip in the row of sources. The **×** of a chip (it shows
when you point at or focus the chip) removes the source from your settings.
The tasks stay on the provider. **Undo** in the toast puts the source back.

### Where a new task goes

There is no default source to set. When nobody names a source, the work says
where its task belongs (`inferTaskSourceKey`), in this order:

1. a source of the task that the work is about: for an agent, the task its
   session works on;
2. the source of the GitHub repository that the work is done in: for an agent,
   its session's checkout;
3. in **New task**, the source of your last new task on this device;
4. your only source.

On a source's own view, **New task** uses that source. With several sources
and no hint, **New task** offers your first source, and you can choose another
in the composer. The agent's `create_task` does not guess: it answers with your
sources, and the agent names one.

## The Tasks page

The Tasks page shows every task of your task sources. It has no project
filter, and a row names no project. The row of sources above the search field
shows each source with how many tasks it holds. **All** shows every source
together, grouped by status category. A source chip shows that source in the
provider's own columns. You also narrow the list by column or status, and with the filters **Agent running**,
**Overdue**, **Assigned** and **Snoozed**. The search finds a title, a
reference, a label or an assignee.

The client asks one host for your sources and their tasks, the task host: the
host of this computer when it is connected and runs agents, else the primary
connection when it runs agents. On the web and on a phone there is no host of
this computer, so the primary connection is the task host. With no such host
connected, the page says that no machine can read your sources. A task row
names the host that reads it when that host is not this computer.

- **Source switcher.** With more than one source, choose one source or **All
  sources**. One source shows the provider's own columns. **All sources**
  groups the tasks by status category (Open, Active, Done), because the
  columns of two sources do not line up.
- **List and board.** The list has one section for each column of the view.
  The board has one column for each. Drag a card to another column, or use
  the keyboard on a focused card: Option (Alt) with an arrow key moves it, and
  a digit moves it to that column, counted from the left. A board item that
  has no column yet is in a **No column** column; nothing can be moved into it.
  Both layouts use the same empty state. When no task matches the search or
  filters, both show **Nothing matches** with **Clear filters**.
- **Moves.** A move in one source's view sets that column on the provider. A
  move in **All sources**, from the bulk bar, from a swipe or from the context
  menu, sets a status category, and the host chooses the column: it closes or
  reopens a GitHub issue and moves it to the first column of that category on
  each GitHub Project that is a task source on the host; a Jira issue makes a
  legal workflow transition. If the provider refuses, Solus shows the error
  and the task goes back to where it was.
- **Card order.** The order of cards inside a column is yours. Solus keeps it
  on this client for each view. It does not change the provider.
- **New task.** The composer creates the task on the provider, in the default
  source or in a source that you choose. A GitHub repository creates an
  issue, a GitHub Project creates a draft item, and a Jira source creates a
  Jira issue. The composer shows only the fields that the source takes: a
  draft item has a title and a description; a GitHub issue adds labels; a Jira
  issue adds labels, priority and due date. You can also choose the column
  where the task starts.
- **Start a session.** A task has no project, so Solus guesses one, and the
  draft shows it on its project chip. For a GitHub issue, the guess is the
  checkout of the issue's repository (`owner/repo` of `owner/repo#123`) on a
  connected host. For a Jira issue, a draft item, or a repository that no
  connected host has, the guess is the project of the input bar. Change the
  project on the chip before you send the first prompt.
- **Refresh.** The refresh button makes the host read each source from its
  provider again. Without it, the host reads a source that is older than 30
  seconds when you open the page, and reads again each 5 minutes while the
  page is in use.

## The task page

The task page reads the task from its provider each time you open it.

- **Status** is the provider's own state, with the task's column in each
  source that lists it. The move menu offers the columns of each source.
- **Fields.** You can change a field only when the provider takes that change
  for this task. A GitHub issue takes a priority or a due date only when a
  GitHub Project that it is on has that field. A change that the provider
  refuses shows the error, and the old value stays.
- **Delete.** You can delete a draft item of a GitHub Project. You cannot
  delete an issue from Solus: close it, or move it to a done column.
- **Copy link** copies the provider's URL of the task. A task has no Solus
  share link.

## What Solus adds: attachments

Solus keeps these about a task, by the task's stable provider id:

- links to sessions (a session that works on the task, or one that only refers
  to it);
- links to documents, plans, automations and pull requests;
- your [snooze](task-snooze.md) and your read mark;
- a record of what Solus did to the task.

An attachment has an organization: that of the session or the person that made
it. In an organization, the organization's cloud keeps attachments only. It
stores no tasks. Each member reads a task with their own GitHub or Jira
connection, so a member sees a task only if the provider lets them.

A task is not shared in Solus. It has no share list, and a guest link never
reaches a task. To let a person see a task, give them access on GitHub or Jira.

## Comments

Each comment is a provider comment. When you write a comment, Solus posts it to
GitHub or Jira.

If the provider does not take the comment (you are offline, or the connection
has a problem), the comment stays on the task as **not sent**, with the reason.
**Retry** sends it again. **Discard** deletes it. Solus does not send an unsent
comment again by itself.

## What agents do

The task tools are Solus tools that write to GitHub or Jira with the connection
of the person the turn acts for ([Solus tools](solus-tools.md)).

- **Session start.** When a session starts work on a task that is Open, Solus
  moves the task to Active on the provider. If the move fails, the session
  starts anyway.
- **`list_tasks`** lists the tasks of your task sources and names the source
  keys. A `source` argument limits the list to one source.
- **`create_task`** creates a real task in the source that the agent names by
  its source key. Without one, it uses the source that the session points to
  (see [Where a new task goes](#where-a-new-task-goes)); with several sources
  and nothing that points to one, it answers with your sources and creates
  nothing. With no task source, it gives an error that says to add one on the
  Tasks page. In a supervised session it asks for permission, because other
  people see the new task.
- **`update_task_status`** takes a status category (`open`, `active`, `done`)
  or the exact name of a column. Your setting for agent task status changes
  still applies: it can refuse each change, or refuse only a move to Done.
- **`comment_task`** posts a comment on the provider. A comment that the
  provider does not take stays as not sent, and the agent sees the reason.
- **Done on merge.** When each pull request that a task links (directly, or
  through a session that works on the task) is merged, Solus moves the task to
  Done on the provider. This is on by default, and needs no project. To turn
  it off for the pull requests of one repository, set `taskDoneOnMerge` to
  `false` in the config of that project on the host: a listed project, or the
  checkout of a session of the task, whose `origin` is the repository of the
  pull request. Solus waits while a session of the task is in the middle of a
  turn.

A follow-up prompt to a session of a finished task does not reopen the task.

## Offline behavior

The host keeps a copy of each task it read, so the lists and a task page open
without the provider. A task page that shows the copy says so.

A write needs the provider. When the provider cannot be reached, a change of a
field, a move, a new task and a delete fail with an error, and nothing
changes. Solus does not keep such a change to send later. Only a comment waits,
as described above.

## Connection problems

A source that cannot be read shows a warning on its chip. Point at the warning
to see why; click it for the repair: the connection page for a connection
problem, a new read for a failed read. When no task loads, the Tasks page
shows the same message in place of the list.

| State | Meaning | Repair |
|---|---|---|
| Not connected | You have no connection to the provider. | Connect GitHub or Atlassian in Settings. |
| Reconnect | The connection lacks a permission that the source needs: the `project` permission for a GitHub Project, the Jira Software permission for a Jira board. | Connect the provider again and approve the permission. |
| No access | The provider refuses this source for your account, or the source does not exist. | Check the name of the source. Ask for access on GitHub or Jira. |
| Read failed | The provider did not answer the last read. | Use refresh. The tasks on screen are the last copy. |
| Truncated | The source holds more tasks than Solus read. | Use the search: it asks the provider. |

The state is yours. On a host that more than one person uses, each person sees
the tasks of a source only after their own connection read that source.

A write that fails because of the connection says so in its error.

## Limits

- Solus reads at most 200 tasks from one source. The source then shows
  **Truncated**. Search on the Tasks page reaches the other tasks.
- From a GitHub Project, Solus shows issues and draft items. It does not show
  pull requests.
- Solus reads tasks from `github.com` and from one Atlassian Cloud site.
- "Assigned to you" notifications are for GitHub tasks only. Solus cannot tell
  which Jira assignee is you.
- Solus detects the status category of a GitHub Project column from its name
  (for example "Done", "In progress", "In review"). A name that it does not
  know is Open. You cannot correct the category in Solus yet.
- A move to a status category changes only the GitHub Projects that a person
  on the host has as a task source.
- The mobile app shows no tasks.
