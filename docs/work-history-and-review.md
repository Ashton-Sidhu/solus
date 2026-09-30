# Work history and review

A work (a doc, a diagram, or an artifact) keeps every saved version. People in
an organization, and people outside it, can review a work: approve it, request
changes, or comment. The plan is
[Work review and live editing](plans/work-review-and-live-editing.md).

## History

Open **History** in the work header. The list shows every version, newest
first, with who made it, when, and why:

| Reason | When Solus saves it |
|---|---|
| Created | The work's first body. |
| Saved | The body just before an agent write, a pull, or a restore replaced it. |
| Agent edit | An agent wrote the work (`update_work`). |
| Pulled from upstream | A pull from Google Docs or Confluence. |
| Sent for review | A review request, or a decision on the current body. |
| Restored | A restore made an earlier version current again. |

A person's normal saves do not add a version. The **Current version** row shows
the body on screen when no version holds it yet.

Select a version to compare it with the version before it. **Compared with**
chooses any other version, or nothing. Docs show a rendered block comparison;
**Markdown** shows the source diff. Diagrams mark added, removed, and changed
nodes and edges on the canvas and list them. Artifacts show the two renders side
by side.

**Restore this version** makes that body current again as a new version.
Nothing is deleted: the body it replaced stays in the list, so a restore can be
undone by restoring that one. Restore needs edit access, and it refuses a body
that changed after you opened History (save or discard your edits first).

## Review

Review is information only. It does not block publishing, editing, or an agent.

### Ask for a review

Open **Review** in the work header:

- **Add reviewers** from the work's organization, with an optional message. The
  request points each reviewer at a fixed version (**Sent for review**). A
  reviewer who cannot open the work is given it as a **commenter**: they can
  read, comment, and decide, but not edit.
- **Copy review link** for people outside the organization. Anyone with the link
  can comment and review; the host names them from the name they type. A Local
  work on a machine has no link anyone else can open, so this opens the Share
  dialog, where the work is published into the organization first.
- **Request review again** (the arrow on a reviewer's row) after a decision,
  and **Remove** a reviewer.
- **Send open comments to agent** sends the open threads to the work's session
  (or a new one). The agent edits the work, then answers and resolves each
  thread.

The same commands are in the command palette (**Review this work…**, **Copy
review link**) and in the context menu of a work in the Workspace page. Agents
can ask for a review with the `request_work_review` tool.

### Give a decision

In **Review**, choose **Approve**, **Request changes**, or **Comment**, add an
optional summary, and submit. The decision applies to the saved body you see.
You can change it at any time; the newest decision replaces the older one.

### Review states

The work's state comes from its reviewers' current decisions:

| State | When |
|---|---|
| Draft | No reviewers. |
| Changes requested | A current decision requests changes. |
| Approved | A current decision approves, and none requests changes. |
| In review | Every other case. |

A decision on a body that is no longer current is **stale**: it stays visible
("Approved an earlier version") but does not count. If an edit is undone and the
body is the approved one again, the approval counts again. A reviewer with a
stale decision sees **Changes since my last review**, which opens History from
their reviewed version to the current body.

### What needs you

- **Needs my review** in the Workspace page filter menu (search token
  `is:review-requested`) shows the works that wait for you. The status column
  says **Review** on them, and shows **In review**, **Approved**, or **Changes**
  on works with reviewers.
- The **Workspace** entry in the sidebar, and the phone drawer, show how many
  works wait for your review.
- A toast tells you when someone asks for your review, and when a reviewer
  decides on a work you sent. Turn it off in Settings › Notifications › Work
  reviews. People outside the organization get no notification.

## Presence on works

The work header shows who else has the work open. "editing…" appears under a
person while they change it, and falls five seconds after their last edit. The
Workspace page shows the same faces on the work's row, and the phone's roster
says "In <work>" or "Editing <work>" and jumps to it. Following a person follows
them into works too.

## Live editing

Documents and diagrams are edited live: everyone who has the work open sees
each edit as it happens, with teammates' carets (documents) and selected nodes
(diagrams) in their colour. Concurrent edits merge to the same result on every
client. Two edits to the same diagram field keep one of them; deleting a
paragraph or a node removes a teammate's edit inside it. `mod+z` undoes only
your own edits.

The status beside the title says where your edits are:

| Status | Meaning |
|---|---|
| Live | Every edit is on the host. |
| Saving… | Edits are on their way to the host. |
| Offline · 3 unsent edits | The host cannot be reached. Edits stay on this device, also after a restart, and merge when it comes back. |
| Reconnecting · 3 unsent edits | The connection is back; the edits are being merged. |
| Agent is editing | An agent writes the work. It is read-only for a moment; edits made meanwhile wait and are sent after it. |
| Read-only | You can view or comment, not edit, or (with "update Solus") this client is older than the host. |

The Markdown source stays editable; each change applies as an edit to the
shared document. Signing out, or removing a host, asks before it deletes edits
only this device holds. Artifacts, slides, and Google-linked works are not
edited live. A host from before live editing saves whole bodies as before.

## Roles

| Role | Read | Comment | Decide | Edit | Request review |
|---|---|---|---|---|---|
| Viewer | Yes | No | No | No | No |
| Commenter | Yes | Yes | Yes | No | No |
| Editor, owner | Yes | Yes | Yes | Yes | Yes |

Only a work offers the commenter role in the Share dialog. On a session or a
task, a commenter is a viewer.
