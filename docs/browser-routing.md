# Browser routing

The web client uses normal URL paths, such as `/tasks`, `/settings/general`, and
`/work/<id>`. The same client serves desktop-sized browsers and mobile browsers.
The Electron client keeps its existing in-memory navigation history.

`BrowserRouteHistory` uses the browser History API. Navigation changes the URL
without a document load. Browser Back and Forward update the workspace through
`popstate`. The URL includes companion panes (`p`) and the focused pane (`f`).
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

Focused checks are in `tests/unit/routing-location.test.ts`,
`tests/unit/routing-codec.test.ts`, `tests/unit/routing-router.test.ts`, and
`tests/unit/static-compression.test.ts`.
