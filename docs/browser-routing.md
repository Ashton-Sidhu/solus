# Browser routing

The web client uses normal URL paths, such as `/tasks`, `/settings/general`, and
`/work/<id>`. The same client serves desktop-sized browsers and mobile browsers.
The Electron client keeps its existing in-memory navigation history.

`BrowserRouteHistory` uses the browser History API. Navigation changes the URL
without a document load. Browser Back and Forward update the workspace through
`popstate`. The path is the leading pane's destination. The URL also includes
the companion strip (`p`, its surfaces joined by `!`), the active surface (`a`,
only when it is not the last one), and the focused pane (`f=1` for the companion
pane). A link to a surface, such as `/task/<id>`, opens it beside the
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
