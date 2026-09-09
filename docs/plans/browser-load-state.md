# Browser load state

The desktop native browser keeps the dev server picker visible until the
document emits `did-finish-load`. Navigation commits and title changes report
the current state; they do not mark the document ready. `did-stop-loading` does
not indicate success, because it also follows a failed load.

A main-frame failure remains visible until another load starts. If the first
request fails while the guest still reports `about:blank`, use the failed
event's `validatedURL` to report the error. Blank startup documents and failed
URL reads do not report readiness.

This applies to each desktop native guest, independent of its pane or agent
provider. Web, mobile, and remote desktop clients use streamed surfaces. The
Electron headless host already uses `did-finish-load` and preserves load state
on title changes.

Regression tests are in `tests/unit/browser-guest.test.ts`. These tests cover
event ordering; they do not verify native window composition or reproduce
every intermittent dev server connection failure.
