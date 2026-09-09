# Workspace overlay layers

Expanded panes remain workspace content. Their layer is 1000. The desktop native
browser guest uses 1001 when expanded, so it clears its pane but stays below app
overlays. An ordinary browser guest uses 10.

Shared popovers, select menus, dropdown menus, and context menus use 10002.
Tooltips use 10020. Browser controls use these shared defaults. Do not raise a
browser guest above the app overlay band or add per-button layer overrides to
compensate for it.

The shared menu components apply to desktop, web, and mobile, in Editor and Pill
mode where available. Only Electron uses the native guest layer; remote clients
render the browser inside the pane. Providers and connections do not change the
layer order.

`tests/unit/overlay-layering.test.ts` checks that each shared overlay clears both
the expanded pane and the native browser guest.
