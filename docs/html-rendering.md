# HTML rendering state

## Inline revisions

A successful `update_work` for an artifact adds a new inline preview in the
conversation that made the update. Each preview retains its own HTML and title.
Earlier versions collapse when a completed revision arrives. They can be expanded
again, and View latest or the version selector can show another revision in place.
These controls do not navigate away or move focus to the prompt. Failed or partial
updates do not replace the last completed preview. Repeated update events with the
same or an older save timestamp do not add another preview.

Version numbers describe the revisions in the loaded conversation, not the global
work history. The label says Latest in conversation: a work can also be edited from
another session. Works, task links, and Open in split continue to open the current
saved work. Selecting an older inline revision does not change the saved work.

Fenced reply HTML uses an explicit info-string identity, for example
`html render artifact=revenue-chart`. Reusing the identity connects completed
fences across replies. Separate identities, unidentified fences, and image artifacts
remain independent. Titles and HTML similarity never establish identity. A fence
identity does not create a saved work. Use one completed revision per identity in
a reply. A source fence or an unclosed fence cannot supersede a rendered version.

Saved artifact IDs survive history projection as typed receipt metadata. Artifact
update inputs remain available in mobile history because they reconstruct the
preview. Both providers and local/remote clients use the same history and renderer
paths. Older hosts without receipt metadata can show standalone previews; clients
do not guess their work identity by title.

HTML blocks, artifact works, document embeds, and HTML file previews share
`SandboxFrame`. Theme changes update the injected stylesheet through a message
from its parent; they do not assign `srcdoc`. Changing the HTML or selecting Reload
still reloads the document. A selected render width is a CSS width, including
when it exceeds the pane and requires scrolling.

An HTML block in a reply has no source view. Its actions are Save as HTML,
which downloads the markup to the client device; Save as artifact, which
creates an `artifact` work; and Open in split, which saves the work first when
the block has none and then opens it in the companion pane. The fullscreen
overlay remains for renders that have no work to open: images, HTML file
previews, and artifact cards without a work reference. A snippet the reader
rendered by hand keeps a Show source action as its way back.

The artifact pane has no source view either. Its header carries Save as HTML:
on a local host it opens the save picker; on a remote host the browser
downloads the file. The overflow menu keeps the same HTML format under Save
as and Download, and adds Export…, which has the work's host write the stored
work to a path chosen in the same picker (`worksExport`). Every work type has
Export…: Markdown for a document, JSON for a diagram or slides, HTML for an
artifact.

HTML file panes retain the source editor after its first use. Preview reads
its current contents and flushes pending saves before switching. A failed save
leaves the source editor and its draft available. Preview is not proof that a
file was saved.

Document HTML serialization chooses a backtick fence longer than any backtick
run in the payload. Parsing requires a matching closing fence on its own line.
The payload survives save and reopen; fence formatting can be normalized.

Each provisional artifact carries its originating tool-call ID. Preview
updates, failures, and completion use that ID. Both provider adapters supply
it through the tool context, and `artifact_created` carries it across IPC and
WebSockets. A completion from an older host without this field appends a new
card rather than taking another call's card. Turn cleanup removes unmatched
provisional cards. Native image artifacts do not consume HTML placeholders.

The PR artifacts section matches the PR URL's repository, PR number, and task
host. It never matches a PR number alone across the shared task collection.
