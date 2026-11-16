# Browser routing

The web client uses normal URL paths, such as `/tasks`, `/settings/general`, and
`/work/<id>`. The same client serves desktop-sized browsers and mobile browsers.
The Electron client keeps its existing in-memory navigation history.

`BrowserRouteHistory` uses the browser History API. Navigation changes the URL
without a document load. Browser Back and Forward update the workspace through
`popstate`. The path is the leading pane's destination. The URL also includes
the companion strip (`p`, its surfaces joined by `!`), the active surface (`a`,
only when it is not the last one), and the focused pane (`f=1` for the companion
pane). `/app/<slug>` opens an app as the destination; with no host in the
address it is the first connected host that has the app.
`/app/<slug>/manage/<section>` opens its Manage page on one section
(`docs/apps.md`). `/folio/apps` opens
the Workspace page on its Apps tab. A link to a surface, such as `/task/<id>`, opens it beside the
conversation (`docs/plans/companion-surfaces.md`).
On refresh, a direct path takes priority over the saved workspace. Opening `/`
restores the saved workspace. Old `#/...` links are converted to paths with
`replaceState`, so conversion does not add a Back step.

The cloud application's catch-all route serves the client document after its
sign-in and welcome checks. Its account, API, and share routes keep their existing
owners. The standalone host also serves the client document for browser
navigation, including project paths with dots. Missing build assets return 404.
A deployment must support this document fallback for direct paths and refresh.

Shared resource links such as `/w/<id>#<secret>` and `/s/<id>#<secret>` retain
their fragment. This is an access secret, not a navigation route. Pairing tokens
also keep their existing fragment format.

## Back and forward

The router is the one history for every way back and forward: the buttons in the
session sidebar header (beside the collapse button), `mod+[` and `mod+]`
(`global.history-back` and `global.history-forward`), the mouse side buttons on
desktop, and a two-finger trackpad swipe on desktop. Each button is disabled when
`RouterStore.canGoBack` or `canGoForward` says there is nowhere to go. On web these
answers come from the Navigation API; a browser without it keeps both enabled and
stays authoritative.

The swipe is desktop only. A browser already swipes through its own history, and
the router follows it through `popstate`, so a second swipe handler would navigate
twice. The gesture (`components/layout/lib/history-swipe.ts`) shows a circle at the
edge of the main content area and navigates when the fingers lift after 120px. DOM
wheel events have no touch phase, so the lift is the macOS momentum tail (steps
that shrink by a near-constant ratio), an empty wheel event, or Chromium's
`gestureScrollEnd`, which desktop main forwards as `onTrackpadScroll`. Swiping back
below 120px or holding still before the lift cancels. A swipe does not start over
a dialog or over content that can still scroll horizontally in that direction,
such as a diff, a code block, or a wide table. The native mobile app keeps its own
platform back navigation.

Focused checks are in `tests/unit/routing-location.test.ts`,
`tests/unit/routing-codec.test.ts`, `tests/unit/routing-router.test.ts`,
`tests/unit/history-swipe.test.ts`, and
`tests/unit/static-compression.test.ts`.

## The phone's browser viewer

The native mobile app shows a host's browser pages in T3 Code's browser
viewer. A session's floating control has a globe button while its host has an
open page; the thread header's **Environment → Browser** opens the same viewer.
It opens on the page the session's agent used last, or else the newest page.
Pages belong to the host, so every session on the host lists them, as the
desktop pane does.

The viewer subscribes to the page's frames on the host socket's binary side
channel, as the web client's streamed surface does, and paints them in a
WebView. One frame is in flight at a time: a frame that arrives while the
WebView paints replaces the waiting one, so a slow phone shows the newest
picture. The host streams no more pixels than the phone's view can show.

A tap is a `clickAt`, a drag scrolls (`scrollAt`), and typed text is
`insertText`; Return, Backspace, and the arrow keys are `press`. Before a tap
ends, the viewer asks the page if the element under the finger takes text, so
iOS raises the keyboard inside the tap. The options menu has Paste, Hard
reload, Appearance, Zoom, Viewport (Fit to screen, which sizes the page to the
phone, and a phone, tablet, and desktop preset), Downloads, and Close tab. A
tab that an agent is using asks before it closes. On iOS, the viewer can show
the page in picture in picture. When an agent of the open session asks to show
a page, a small live player opens over the thread; a tap opens the viewer.

## What a page asks of the person watching

A page can ask for things a browser normally answers with its own windows: a
JavaScript dialog (`alert`, `confirm`, `prompt`, or the leave-page question),
files for a file input, and a place to save a download. A page the host renders
headless has no window anyone can see, so these are page state
(`BrowserPage.dialog`, `fileChooser`, `downloads`) and every client that shows
the page answers them. The first answer from any client wins.

- **Dialogs.** The web client and the phone show the page's question over the
  streamed page, with the browser's own answers (OK, Cancel, Leave, Stay, and
  a field for a prompt). A dialog waits while a client streams the page. With
  no one watching, a headless host dismisses it unless an agent answered first
  (`browser_dialog`). A page in a desktop pane keeps the system dialog.
- **File choosers.** A headless host holds the page's file chooser open
  (`fileChooser`). The client uploads the files the person picks to the host,
  into the page's own upload folder (`browserFileUploadToken`), and gives the
  chooser the host's copies (`browserAnswerFileChooser`). The host takes only
  files from that folder, never another path on the host. A file keeps its name,
  so the page shows the name the person chose. A page in a desktop pane keeps
  the system picker.
- **Downloads.** Every download lands on the host as an asset, from a desktop
  pane too. The page keeps its last five (`downloads`). A client that watched
  the download finish offers to save it; the web client and desktop also list
  them in the toolbar's More menu, and the phone in its options menu.

## Zoom and hard reload

Zoom is page state (`zoomFactor`, one of the browser's steps from 25% to 300%),
so every client and every agent sees the size the page lays out at. The page
lays out at its viewport divided by the zoom, as a browser's own zoom does. A
headless stream is that smaller CSS size, so the client that fits it into its
pane shows the page zoomed. A desktop pane's guest scales its view back up to
the pane. Streamed clients map a pointer into the guest's own CSS pixels
(`browserGuestViewport`). The web client and desktop show a zoomed page's
percent beside the More menu; it resets the zoom.

Hard reload (`browserNavigate` with `{ kind: 'reload', ignoreCache: true }`)
fetches every resource again. It is in the More menu and the phone's options
menu.

