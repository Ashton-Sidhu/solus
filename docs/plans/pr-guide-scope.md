# Pull request guide scope

Each host stores one guide per provider, repository, and PR number. The project,
conversation, branch name, checkout path, and selected stack comparison do not
create separate PR guides. A successful generation replaces that saved guide.
Failed or cancelled replacement runs keep the previous guide.
Compatible guides from older checkout caches are promoted to this slot when
read. Migration preserves their recorded commits and cannot overwrite a new
generation that finishes during the read.

PR guides cover the full PR. Generation resolves the current provider base and
head, then prepares those commits. The local default branch must not replace
that base. List actions, automatic generation, commands, background warming,
and regeneration use the same PR target and host job owner. Branch and session
reviews retain their own scope rules.

The host exposes a queued job before checkout preparation starts. It reports
preparing, analyzing, writing, and terminal states through the shared guide
store. Navigation does not own or cancel a job. Clients read status on entry and
revalidate tracked guides after reconnect. Late reads cannot replace newer
events. Cancellation and a later request prevent an earlier run from saving.

Freshness compares both recorded commits with the current provider revision.
The PR list must not compare its target-branch tip with the saved merge base:
those are different revisions even for a current guide. The host owns that
base check; the list can still mark a known head change outdated immediately.
The guide shows an outdated warning with a regenerate action. Its diff and file
contents still read the recorded commits. A same-head replacement must reload
the saved content too. While a replacement runs, the previous guide remains
readable with progress and a cancel action. Failure and cancellation expose a
retry action. Connection and load failures remain visible.

The guide loader is idle until it starts a request. Background generation has
its own shared status, so reopening a pane during generation must not block the
finished guide from loading. Failed loads clear the local loading flag.

PR list rows load guide status on entry and show compact state icons with
accessible labels. Saved guides remain identifiable after reopening the list.
An open-book symbol identifies guides; a check or a small status badge shows
whether the guide is ready, queued, generating, outdated, failed, or cancelled.
In PR list rows, the guide icon sits beside the checks icon, separated by a dot,
without a background or border. Filters → Review guide → Has review guide
limits the list to saved guides, including outdated guides and saved guides
whose replacement is running or failed. The filter survives opening a PR and
returning to the list; All pull requests clears it.
Pagination uses a fixed footer outside the virtual list so newly matched guide
rows do not move the Load more pull requests button. Its loading state keeps
the same width. The button remains available when no loaded rows match a
filter but more pull requests are available.
Color denotes status: green for ready, amber for outdated, blue for generating,
red for failed, and gray for queued or cancelled. Icons and accessible labels
also identify each state. Its icon uses one em of the shared workspace-chrome scale: 12px
on laptop displays and 14px on larger desktop and coarse-pointer clients.
The activity card uses icon actions so the guide row fits a narrow pane.
Each live PR guide completion shows a ten-second toast with an Open guide
action bound to that PR and host. Cached reads do not replay completion toasts.
The batch action reports failures; successful guide events own completion
toasts to avoid duplicate success messages.

File cards register their DOM references through their lifecycle action. Large
sections must release those references without a recursive binding cleanup
chain. Sections show at most 40 file cards per page; low-signal content mounts
when opened. The shared guide components serve desktop, web, and mobile.

A guide already saved with an incorrect base must be regenerated after the host
loads the fix. Changing the producer does not rewrite existing guide content.
