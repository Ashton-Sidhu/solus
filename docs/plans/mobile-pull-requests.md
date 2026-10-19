# Mobile pull requests

Status: implemented (2026-10-12). The diff surface needs a new native build before device proof.

The native mobile app (`apps/mobile/`) gets the pull request workspace that the
desktop and web clients already have. The design follows T3 Code's mobile port of
the same feature, so it stays in line with the rest of the ported interface
(`apps/mobile/UPSTREAM.md`):

- [t3code#18126](https://github.com/pingdotgg/t3code/pull/18126): browse and review pull requests natively.
- [t3code#18267](https://github.com/pingdotgg/t3code/pull/18267): guided reviews for pull requests.
- [t3code#18351](https://github.com/pingdotgg/t3code/pull/18351): keep pull requests available offline.

Source commit for the port: T3 Code `e2e95a39d` (2026-10-12).

## Scope

Mobile only. The server already has every RPC that this needs (`prListProjects`,
`prGetOverview`, `prListComments`, `prListCommits`, `prChangedFiles`, `prGetDiff`,
`prGetDiffFileContents`, `prListThreads`, `prReplyThread`, `prResolveThread`,
`prSubmitReview`, `prMerge`, `prEnableAutoMerge`, `prUpdateBranch`,
`prUpdateLifecycle`, `prListReviewers`, `prRequestReviewers`, `prSetLabels`,
`prGuideStatuses`, `requestReviewGuide`, `readGuide`). No contract, server, or
desktop/web change is part of this plan; the later GitHub actions below use
host calls from a separate server change.

## Vocabulary

- **Pull Requests tab** — the second list tab beside **Chats** in the mobile
  workspace. It lists pull requests of every connected host.
- **destination** — one of the top-level places of the Android workspace
  navigation: **Chats**, **Pull Requests**, and **Settings**. The two list
  tabs are workspace state; Settings is selected while its pages are on top
  of the root stack (`workspace-destinations.ts`).
- **navigation rail** — the Android destinations in a split layout: a 72dp
  column at the leading edge that widens to 240dp over the panes.
- **pull request detail** — the screen for one pull request. It has the tabs
  **Overview**, **Activity**, **Commits**, **Files**, and **Guide**.
- **diff surface** — the native view that draws a unified diff
  (`modules/t3-review-diff`, ported from T3).
- **review draft** — inline comments that the person writes on the diff before
  they submit one review. It stays on the device until it is submitted or
  discarded.
- **guide** — the Solus review guide for a pull request
  (`ReviewGuide` in `packages/contracts/src/review.ts`). On mobile it is shown as
  a tour: one stop for each guide section, in section order.
- **pull request cache** — the device copy of read pull request data, so that a
  pull request that was read once is still readable offline.

## Architecture

### Data (`apps/mobile/src/features/prs/`)

Stores follow the Solus mobile pattern: a class with `changes: Listeners`, reads
as `LoadState<T>`, components read with `useListened`. A read that a newer read
or a new server session made stale is dropped (`PullRequestDirectory.read`).

- `pull-request-directory.ts` — lists across hosts and the detail parts.
- `pull-request-diffs.ts` — diff pages for one pull request (optionally one
  commit), with the provider cursor; file contents for context expansion.
- `pull-request-actions.ts` — commands: merge, auto-merge, update branch,
  lifecycle, reviewers, labels, review submit, thread reply/resolve, stack
  merge, revert, workflow approval, and viewed marks.
- `pull-request-guides.ts` — guide status, read, and request for a pull request.
- `pull-request-review-drafts.ts` — the review draft of each pull request.
- `pull-request-cache.ts` — the pull request cache in `expo-sqlite`.

Server mutations need a connection. Reads show the cached value when the host is
not reachable, with the state marked as not refreshed.

A read again, or a PR sync push, that answers what shows already keeps the
shown objects (`lib/pull-request-retain.ts`, the `retain` option of
`HostReads`): pull requests pair by number, projects by folder, and each detail
part apart. The read state still goes from loading to loaded, so spinners,
notices, errors, and the offline line stay true; only a value-only selector
sees no change. The list reads its host states and its rows as two snapshots
(`PullRequestListSelection`): an equal refresh renders no row again, and a
changed pull request renders only its row. Diffs and guides do not use
`retain`.

Cache bounds (from T3): 30 days, 256 records, and 32 MiB for each host; a
response larger than 4 MiB is not cached.

### GitHub actions added later (2026-10-12)

These use host calls that were added after the first port
(`packages/contracts/src/host-api.ts`). Each one shows only when the code host
(`pr.capabilities.actions`) and the person's account
(`pr.viewerPermissions.actions`) both allow it (`lib/pull-request-permissions.ts`).

- **Stack merge** (`merge-stack`): a "Merge stack" button under the merge
  button, when the pull request is in a stack and more than one open layer
  lands. The confirmation lists the layers. It sends the layer heads that the
  device read with the stack (`expectedHeads`); a `queued` answer says so.
- **Workflow approval** (`approve-workflows`): the detail reads
  `prPendingWorkflowRuns` for an open fork pull request, as an optional part
  that is also in the device copy. The waiting runs show in a row under the
  checks, with "Approve and run".
- **Revert** (`revert`): in the status menu of a merged pull request. After
  the host opens the revert pull request, the screen opens it.
- **Viewed files**: when `pr.capabilities.viewedFiles` is true, GitHub's
  viewed state is the record. It is read when the pull request opens; marks
  go in one write after a short pause, show at once, and go back with a short
  reason when the write fails. "Changed since viewed" lists the files that
  GitHub marked `dismissed`. Offline, the device copy shows and a tap does
  nothing. Without the flag, the marks stay on the device as before.
- **GitHub media**: an image or video whose URL `githubMediaFetchUrl`
  accepts loads through a URL the host signs (`prMediaUrl`, on the
  collaboration plane, so a host that serves only pull request records signs
  it too), when the host has the `githubMediaUrls` capability.
  Other media, an older host, or a refusal loads the direct URL.

### Diff surface

`modules/t3-review-diff` (Swift and Kotlin) and its JS adapters
(`src/features/review/`, `src/features/diffs/`) are ported from T3 with the T3
attribution line. Patches parse with `@pierre/diffs`, as in T3 and in the Solus
workspace UI. This module needs a new native build of the app.

### Navigation

- `Home` becomes the workspace root with two tabs, Chats and Pull Requests
  (`src/features/workspace/`). The per-host `PullRequests` route is removed;
  a host's pull requests open as the Pull Requests tab filtered to that host.
- Android shows Settings as a third destination (2026-10-19, T3 #20813). See
  "Android destinations" below.
- New stack routes for the pull request detail flows: `PullRequestReview`,
  `PullRequestInlineComment`, `PullRequestReviewers`, `PullRequestLabels`
  (sheets) and `PullRequestDiscussion` (pushed).

### Guide

The Guide tab shows only when the host returns a guide status for the pull
request. Writing a guide uses `requestReviewGuide` with a `pr` target. A guide
whose `headSha` is not the pull request head is shown as outdated. Stops come
from `GuideSection`; each stop shows the section's `hunks` on the diff surface.

## Platform decisions

- iOS and Android get the same capability. iOS uses the UIKit system tab bar
  from T3's react-native-screens v5 fork (`apps/mobile/deps/`). On a phone,
  compose is the tab bar's detached search-role tab and opens New Task; a
  wide iPad window picks the tab in a segmented control at the top of the
  sidebar and keeps compose in the bottom toolbar. Android keeps its Material
  navigation bar.
- Desktop and web are not changed: they already have this capability.

### Android destinations (2026-10-19)

The maintainers chose T3's Android navigation (#20813) without its history
and transition defects. This replaces the earlier rule of two root tabs on
Android; iOS keeps its two system tabs and the Settings button in the header.

- **Phone:** the Material bar has Chats, Pull Requests, and Settings. Settings
  opens over Home without an animation, and the bar stays under Settings and
  its pages. Settings opened over a conversation is an ordinary page: no bar,
  and Back returns to the conversation.
- **Split layout:** the navigation rail replaces the bar. It holds a menu
  button, New session, and the three destinations as icons. The menu widens it
  to 240dp over the panes with labels and a scrim; Back, the scrim, or a
  choice closes it. The rail hides with the sidebar. The sidebar has no New
  session button of its own. Settings opens in the content pane beside the
  sidebar, as before; it does not hide the sidebar, so the sidebar never
  blanks or overlaps Settings while the native screen attaches (T3's open
  defect).
- **History:** choosing Settings keeps the stack under it. Choosing the shown
  list tab from Settings closes Settings and returns to where the person was.
  Choosing the other list tab goes to Home and selects it, as the iPad sidebar
  picker does. A tab change still clears search.
- **Retained lists:** Chats and Pull Requests each mount on the first visit
  and then stay mounted while hidden, behind React `Activity`
  (`WorkspaceTabPanes`). A return shows the list as it was left. A hidden list
  runs no effects: its search Back handler, header options, focus refresh, and
  host reads stop, and run again with their freshness guards when it shows.
  At most the two lists are kept. iOS already retains its native tab trees.

### Pull request detail (2026-10-19)

- **Segmented control:** iOS draws UIKit's segmented control through the
  installed `@expo/ui` SwiftUI segmented Picker (T3 #20327 used its own native
  module). UIKit supplies drag selection, VoiceOver traits, Dynamic Type, and
  reduced motion; the control follows the app's light or dark appearance with
  the system colors. A choice the caller refuses remounts the control on the
  caller's value. Android keeps Material segmented buttons.
- **Share:** both detail menus have Share… beside Copy link and Open on GitHub,
  shown when Copy link is (T3 #21250). iOS shares the URL; Android shares the
  URL as the message, with the title as the subject. A cancelled sheet is not
  an error; a failure shows an alert. On iPad the sheet is a popover over the
  window, since a native menu item is not a view it can point at. Desktop and
  web keep Copy link and Open on GitHub as their equivalent.
