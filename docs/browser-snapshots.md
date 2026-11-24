# Browser snapshots

An agent looks at a browser page with `browser_snapshot`. The result has a
screenshot, the elements the agent can act on, the text on screen, and the
console and network history. The agent trusts this result, so the result must
tell the agent when it does not show the page as it is.

## What a snapshot says about itself

- **The document is still loading.** The structure read records
  `document.readyState`. The result starts with `state: the document is still
  loading.`
- **The page changed during the snapshot.** The structure read starts a watch on
  the content of the page (`childList` and `characterData`, not attributes). The
  read after the screenshot stops the watch. If the content or the URL changed,
  the result has a warning, because the picture and the elements can be of two
  different moments (`changedDuringCapture: 'content'`). If the document was
  replaced, the snapshot is read again one time from the new document. If it
  changes again, the warning says `navigation`.
- **Something covers an element.** Each element gives the element at the centre
  of its box (`document.elementFromPoint`). If another element is on top, the
  element has `coveredBy` (for example `div#solus-boot-shell`). If one element
  covers more than half of the elements, the result says that an overlay or a
  loading screen is in front of the page.
- **The visible text.** The text that a person can read in the viewport, in
  document order, up to 1000 characters. Text that the page shows as dots is
  not included.

## A current frame on desktop

A desktop page with no pane is a window that is never shown. Such a window can
stop presenting frames, and then it gives the last frame that it drew. One
snapshot showed the boot splash of an app whose workspace was already in the
DOM. So a headless capture takes a warm-up copy and discards it, waits for two
animation frames (one second maximum), and then takes the copy that it keeps.
A page in a pane asks its own surface for one new frame through a screencast.
If a capture or click waits for a frame, Electron requests a fresh frame from
that guest without showing its window. This also applies to a guest parked
when its pane is closed.

When a desktop page is in the background, Solus can send a click at a page
coordinate to a cross-site iframe under that point. Snapshot refs and
selector lookup still address the top document.

## Waiting for a page

- `browser_navigate` returns when the document has loaded and its content has
  not changed for 500 ms, or after 3 seconds. The result says which, and gives
  the URL, the title, and the visible text. A single-page app can still be
  starting after `load`.
- `browser_wait_for` waits until all of its conditions are true: `text` on the
  page, a `selector` that matches an element with a size, a URL that contains
  `urlIncludes`, and an `expression` that is truthy.
- `browser_click` and `browser_type` wait up to 2 seconds for the element to
  show and to be on top. If something still covers it, the click goes to the
  centre of the element, as a person's click would. The result then says which
  element was clicked.

## Refs

A ref is `[data-solus-browser-ref="e4"]`. The tools also accept `e4`. Each
snapshot gives new refs. If a ref finds no element, the result tells the agent
to take a new snapshot.

The code is in `packages/server/src/browser/page-script.ts` (the scripts that run
in the page), `browser-registry.ts` (`snapshot`, `settle`, `clickOrType`),
`browser-tools.ts` (the agent tools and their text), and
`apps/desktop/src/main/browser/chromium-driver.ts` (`captureScreenshot`).
