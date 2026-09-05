# HTML rendering state

HTML blocks, artifact works, document embeds, and HTML file previews share
`SandboxFrame`. The iframe stays mounted when an artifact pane switches to
Source. Theme changes update the injected stylesheet through a message from
its parent; they do not assign `srcdoc`. Changing the HTML or selecting Reload
still reloads the document. A selected render width is a CSS width, including
when it exceeds the pane and requires scrolling.

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
