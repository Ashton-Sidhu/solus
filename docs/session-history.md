# Session history loading and scrolling

The shared desktop, web, and mobile workspace displays a loaded transcript before
git identity and task binding finish. Late metadata updates apply only while the
tab still owns the session that requested them.

`loadSessionPage` returns complete turns and an opaque cursor for the next older
page. The message limit is a target: a large turn can exceed it. Keeping a turn
together lets the client correlate tool calls and results without reloading the
newer history. Claude cursors use file byte boundaries and a boundary fingerprint;
Codex cursors use turn ids. Appending live output does not move these boundaries.
Provider handoffs are paged from newest to oldest with their dividers preserved.
Invalidated cursors fail explicitly and leave the current transcript intact.
Late child-agent activity is retained until an older page supplies its owning
tool call, then attached to that call instead of shown as a top-level message.

The client prepends each older page and preserves existing message objects. Find
and the scroll-to-start command can fetch all remaining pages, but do not mount
all of their components. Older remote hosts can use the existing loading method;
permission failures and failed cursor reads do not trigger that fallback.

Transcript turns are virtualized with measured heights and viewport overscan.
The height cache preserves a scroll anchor when history is prepended or a row's
height changes. While a scroll correction waits for updated spacers, row selection
uses the corrected position so the visible turns stay mounted. Find and the
message navigator first mount the target turn.
Selected text and focused controls keep their rows mounted. Tool and agent-card
disclosures, agent selection, and agent reply drafts belong to the conversation
so recycling a row does not reset them. A single very large expanded turn remains
one virtualization unit; the limit is on mounted turns, not their inner nodes.

`session_history_page_loaded` logs the host duration, message count, and whether
more history exists. It does not measure client paint time or scrolling frames.

On boot, desktop, web, and mobile start the active saved session's bounded history
read before importing the workspace. Restore consumes that request once. The
prefetch is scoped to the host API, provider, session, checkout, page limit, and
mobile tool-input policy. Failed or expired reads use normal restore and its
older-host fallback. Pending forks are not prefetched.

Web and mobile reuse the validated host directory returned by the cloud-origin
probe during startup. They do not request `/v1/hosts` again to select a host.
Later directory refreshes still fetch current data. An invalid response leaves
the saved host catalog intact. Desktop uses its existing native account source.

Forks have independent names. Before the first prompt, a fork keeps its name in
the saved client state. When the provider gives the fork its own session ID, the
client saves the chosen name to the host. Renaming the source does not change a
pending fork's name.

Host metadata and inactive session probes yield a frame first. Restore-related
Git and task reads start after a transcript paint opportunity. They do not delay
live session attachment. Background clients use a bounded timer because browsers
can suspend animation frames. History still applies before the live watch starts.

The browser Performance timeline contains `solus.boot.transcript.requested`,
`received`, `applied`, and `painted` marks for the prefetched active transcript.
The last mark comes from the visible conversation after two animation frames;
it indicates a paint opportunity, not a GPU presentation measurement. Empty
sessions and failed restores do not report transcript paint. With
`SOLUS_STARTUP_TRACE=1`, desktop also writes these marks to the startup trace.
`bun scripts/measure-startup.ts --transcript` measures through that mark and
requires a disposable, nonempty restored session in its isolated bench profile.
The default benchmark still measures window readiness.

Desktop, web, and mobile mount the workspace as soon as its renderer is ready,
without waiting for the saved conversation's history. Saved tabs and drafts are
available immediately, and the conversation shows its loading state while history
arrives. A slow or unavailable host cannot hold the workspace behind this read.
If the page arrives before mount, component setup uses it in the first frame.
Otherwise normal hydration consumes the pending request once, with the existing
session ownership checks and reconnect recovery. History still applies before
the live watch starts. Automation cards reconcile when normal hydration completes.

The desktop shell does not mount ahead of its conversation renderer. Sidebar,
project-panel, command-palette, and mobile session-list modules load after a paint
opportunity. The session picker loads when opened. Their promises do not gate the
initial transcript. Unavailable hosts and older hosts that lack page reads still
use normal connection and history recovery.

While the sidebar module loads, desktop and web show a static skeleton in its
reserved pane, with the collapse control available. Mobile loads the drawer shell
with the workspace and defers its session list; opening it before the list is
ready shows the same skeleton. The placeholders use theme colors and do not animate.

Session rows under a task show the host name beside its icon on desktop,
web, and mobile. Long names truncate within the row; hovering shows the full
name. The name remains visible when the runner is offline.

Linked task PRs load from summaries held in host memory in `tasksSidebarSnapshot`.
Sidebar boot, reload, and reconnect do not register PR interests or make provider
requests. The snapshot includes the last known title, URL, state, draft flag,
repository, update time, and observation time. Missing observations leave the
durable task link visible; an unavailable provider does not imply a closed PR.

The host's single `PrReconciler` starts its first background pass after one minute.
It combines linked PRs by repository and number, saves open PR summaries as well
as closed ones, and publishes updates through the existing task invalidation and
PR lifecycle events. Open PRs refresh at most once a minute; closed and merged
PRs use a fifteen-minute cadence while their task remains active. Closed PRs can
be reopened. Failed reads keep the last good summary and a five-minute retry
deadline. Summary freshness and failure deadlines survive client reloads and reconnects,
but clear when the host process restarts. No PR summary or retry deadline is
written to SQLite or other disk storage. After a host restart the durable link
label renders immediately; its current status arrives from background refresh. An older pending worker response
cannot overwrite a summary written by a newer explicit PR action.

A merged PR completes the tasks that link it. The host owns that rule in one
place, `completeTasksForMergedPullRequest`; clients only show the result. A task
is done when every PR it links is merged, unless the project sets
`taskDoneOnMerge: false`. Two guards hold it: a task changed after the merge
(reopened, edited, or given a new session) stays as the user left it until the
PR itself changes again, and a task whose working session is still busy waits
for a later pass. The reconciler asks again on every pass from the summary it
already holds, so a wait costs no host request. A closed PR does not complete a
task.

Branch-to-task discovery also runs in the host worker. It groups indexed isolated
session checkouts by repository and branch, and writes durable task links.
Shared clones cannot claim branch ownership. Remote attempts use their recorded
branch and the task host's repository; no remote filesystem path is opened. Branch lookup failures back off for
five minutes within the worker. The sidebar can still display a mounted checkout's
already-known PR without starting a discovery request.

`PrsStore` continues to own requests for the Git rail, mobile navigation, PR lists,
and visible merge controls. It combines those explicit surface interests by host
and project, limits concurrency, and waits for the transcript paint signal before
background reads. Opening a PR and pre-merge checks remain immediate. Provider
caching, CI polling, and the review-inbox refresh cadence remain independent.
Thus zero sidebar discovery requests does not mean zero PR traffic when a Git
pane or PR detail is visible.
