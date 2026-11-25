# Mobile artifact pages

Status: implemented.

## Problem

The phone showed each saved artifact (`render_artifact`, `update_work` on an artifact work) with the Solus inline path. The transcript held the full HTML. The frame started at 120 points and grew when the page reported its height. The feed list did not know the row height, so the feed jumped. The page painted with the default palette, and the Solus theme arrived after load.

T3 Code shows an `html_render` page as one feed row with a known height. The row holds only a reference, and the page loads from a signed URL with the theme in the URL fragment.

## Decision

A Solus artifact version on the phone is a T3 `html-render` row.

1. **Reference.** An artifact version has the attachment id `artifact:<workId>:<contentVersion>` (`artifactPageAttachmentId` in `@solus/contracts/artifact-page`). The phone makes the T3 `HtmlRenderReference` from that id, the title, and the layout.
2. **Layout.** The host measures each saved version in its headless browser when the tool saves it, at the widths of `previewArtifactHtml`. It keeps the heights by work version (`data/works/artifact-layout.ts`). The heights go on the `artifact_created` and `work_updated` events and on `artifactWorkRef` in history pages that ask for reply layout. A version with no measurement gets the fixed frame of an unmeasured reply (`UNMEASURED_REPLY_HEIGHT`) and scrolls inside it.
3. **Page.** `assetCreateUrl` with an artifact page id reads that version of the work in the caller's record scope. It stores the page document in the asset store and signs a URL for it. The document is the Solus sandbox document that the host measured, plus a small bridge for the T3 theme fragment, the T3 theme message, and links. The host serves it with a `sandbox` CSP, so the page has an opaque origin and cannot read host storage or cookies.
4. **Feed.** The phone uses only upstream T3 logic for artifacts. The conversation adapter gives each saved version to T3's feed builder as a finished `html_render` tool call whose output holds the reference. T3 makes the `html-render` row, gives it a fixed size, and opens its expand button in the T3 attachment reader.
5. **Not on the phone.** The phone has no artifact group card, no folded earlier version, and no works history record when a page opens. T3 has none of them. Desktop and web keep them.
6. **Save timing.** `render_artifact` sends `artifact_created` after its save check, which already waited up to 8 seconds for the render. `update_work` on an artifact now waits for the same check. Desktop shows the streamed render while it waits.

## Limits

- A work that this host does not hold (an organization work in the Solus API, or a work on a task's host) has no page URL. The phone shows "Page unavailable" with a retry.
- A session read from its cloud copy while its host is offline has no page URL, and has no measured frame.
- A phone on this version needs a host on this version. An older host refuses the page id, and the phone shows "Page unavailable".
- HTML fences in replies keep the inline path with host layout. They can move to the same page URL later.
