# Video attachments and browser recordings

Status: implemented. User documentation: [Browser recordings and video
attachments](../browser-recordings.md).

Changes from this plan during implementation:

- `BrowserRecordingEncoder.frame()` returns `{ recordedBytes }`, so the recorder
  can enforce the 50 MB limit while it records.
- Retention uses a small index file (`state/browser-recordings.json`), not a
  database table. A recording that a sent prompt names is kept, as a filed one
  is. Deleting the comment that filed a recording does not make it eligible for
  deletion again.
- Titles and history previews drop the composer's `[Attached file: …]` lines
  (`stripAttachedFileLines`), so a first prompt with a video does not name the
  task or the session after the file path.
- A recording that is still running when the host shuts down is lost.
- Review fixes: upload slots are reserved when bytes arrive and released on
  failure. Completed upload retries return success without overwriting the
  file. Recording stop calls share one save through storage completion, and
  Stop waits for an in-progress start. Hidden players pause. Uplink uses the
  same signed upload route as direct connections.

Users and agents must be able to show UI behaviour as a video. A screenshot
cannot show an animation, a flicker, a focus jump, or a race.

## Vocabulary

- **video attachment** — a video file that a user attaches to a prompt.
- **recording** — an MP4 that Solus makes of a browser page. A recording is
  stored as an asset. It can become a video attachment or evidence.
- **evidence** — a snapshot or recording filed on a task or a pull request
  (existing term, `browser-evidence.ts`).
- **recording encoder** — the Chromium page on the host that turns frames into
  MP4.

Do not use "clip", "screencast", or "capture" for the video file. "Screencast"
stays the name of the live JPEG frame stream.

## Decisions

| Question | Decision |
|---|---|
| Attachment model | A video is a `file` attachment. There is no new type (as t3code does). |
| What the agent gets | The path. Claude and Codex cannot watch video. We do not extract frames. |
| Who records | The host, not the client. Servers, desktop, web, mobile, and agents use one recorder. |
| Encoder | `MediaRecorder` in Chromium that the host already has. No ffmpeg. |
| Format | Record in MP4/H.264. Uploaded attachments can also use MOV and WebM. |
| Pull requests | Publish the MP4 through the GitHub attachment upload (the one `gh --attach` uses). Do not detect the plan. Use a 100 MB limit and show GitHub's refusal, as `gh` does. |
| Retention | Keep only recordings filed on a task or a pull request. |
| Safari | Not a target. The mobile client will be a native app. |
| Agent instructions | One shared runtime block for Claude and Codex, which includes the media line (see below). |

### Why no ffmpeg

t3code does not use ffmpeg. It records in the desktop renderer with
`getDisplayMedia` + `MediaRecorder` (`apps/web/src/browser/browserRecording.ts`).
It asks for `video/mp4;codecs=avc1` first and uses WebM only as a fallback. Its
recording works only on desktop, because it needs the Electron bridge.

Solus uses the same encoder, `MediaRecorder`, but runs it on the host. Every
Solus host that has a browser already has Chromium:

- The standalone server has the Playwright Chromium (`browser-runtime.ts`).
- The desktop host has Electron (Electron 42).

Checked on 2026-09-24: Playwright Chromium 153 in headless mode recorded a
1280×720 canvas stream to a valid MP4 (`ftyp` header, H.264) with
`MediaRecorder('video/mp4;codecs=avc1')`.

### Pull requests

`gh` 2.99.0 (2026-09-01) added `--attach` to `gh pr create`, `gh pr edit`, and
`gh pr comment` for images and video. The installed `gh` is now 2.101.0. There is
still no REST endpoint for attachments. Solus already calls the same upload
endpoint that `gh --attach` uses, directly (`GitHubProvider.publishAsset`,
`providers/github/asset-upload.ts`), and that code already accepts `mp4` and
`mov`. So Solus needs no `gh` call. Limits:

- Uploading needs write access to the repository (checked in `assertCanUpload`).
- There is no public API. The endpoint is `uploads.github.com/user-attachments/assets`,
  which is not documented. The newest GitHub OpenAPI description
  (`@octokit/openapi-types` 29.0.1, checked 2026-09-24) has no attachment
  endpoint. Solus already has the newest `@octokit/rest` (22.0.1). No SDK
  update is necessary. Octokit cannot send this request, so `asset-upload.ts`
  builds it by hand, as `gh` does.

#### Plan limits: do what `gh` does

GitHub accepts videos up to 10 MB when the repository owner has a Free plan, and
up to 100 MB on paid plans. We do not detect the plan, for these reasons:

- `gh` does not detect it. `internal/attachments/userasset.go` says: "The real
  limit depends on the account plan, which gh cannot know before the request, so
  this is the generous bound and the server refuses the rest." Its limit is
  100 MB, and it shows GitHub's 422 message.
- t3code does not upload to GitHub at all, so it has no rule to copy.
- The API cannot tell us reliably. `GET /orgs/{org}` shows `plan` only to
  organization owners (checked: `sidhulabs` shows `free`, `hiddenlayerai` shows
  `enterprise`). `GET /user` shows `plan` only when the token has the `user`
  scope (checked: `null` with the `repo` and `read:org` scopes). Other people's
  accounts never show a plan.

So `asset-upload.ts` keeps its 100 MB limit, and Phase 2 makes it match `gh` in
two small ways:

- Add `webm` (`video/webm`) to `GITHUB_UPLOADABLE_ASSETS`. `gh` accepts it.
  Recordings stay MP4.
- Handle 429 with `Retry-After`, as `gh` does, and show GitHub's 422 message
  in full.

When GitHub refuses a video, the recording stays on the task, and the tool
result tells the agent GitHub's reason.

## Current state in Solus

- Attachment upload: base64 JSON through `attachUpload`, limited by
  `MAX_ATTACHMENT_UPLOAD_BYTES` (10 MB, `packages/contracts/src/rpc.ts:14`).
- Type detection supports images only: `attachment-upload.ts:109`,
  `ws-transport.ts:415`, `attachment-utils.ts:5`.
- Asset serving (`packages/server/src/server/assets.ts`) allows only images, SVG,
  and PDF. Other stored assets download as `application/octet-stream`. The CSP has
  no `media-src`. `GET /api/assets/:token` already supports range requests.
- `MarkdownImage.svelte` turns host paths and `asset://` ids into signed URLs.
  `MarkdownParagraph.svelte` plays only remote `.mp4`/`.mov` URLs.
- The browser registry sends one screencast to many watchers
  (`browser-registry.ts:740-840`). Both drivers implement `startScreencast`.
  Chromium allows one screencast for each page.
- The Codex browser instructions already mention "recordings", but Solus has no
  recording tools. Phase 2 makes that sentence true.

## Phase 1 — send and play video files

### Contracts

- Add `videoMimeType({ name, mimeType })` and `VIDEO_FILE_EXTENSIONS` in
  `packages/contracts/src/` (mp4, m4v, mov, webm). The MIME type wins. The
  extension is used only when the MIME type is empty or generic. Every client
  and the server use this helper.
- Add `MAX_VIDEO_UPLOAD_BYTES = 50 MB`. Images keep 10 MB.
- Add RPC `attachUploadToken({ name, mime, size }) → { uploadUrl, hostPath }`.
  The token is HMAC-signed, expires after a short time, and includes the size and
  the session bucket. Add the capability flag `attachStreamUpload`.

### Server

- `POST /api/uploads/:token` in `http.ts`. Refuse the request when
  `Content-Length` does not equal the size in the token. Stream the body into
  `dataDir()/attachments/<session-bucket>/`, with the same rules as
  `attachment-handlers.ts`. Delete the partial file when the stream fails.
- `assets.ts`: add video MIME types, serve `video/*` inline, and add `media-src`
  to the CSP. Keep `nosniff`.
- `attachment-utils.ts`: map video extensions so local paths get the correct MIME
  type.
- Prompt text: no change. The existing `[Attached file: <path>]` line is correct.

### Clients

- `attachment-upload.ts` and `ws-transport.ts`: use the token upload for all
  videos and for files larger than the RPC limit. Show upload progress on the
  chip. Show Retry when the upload fails.
- Desktop with a local host: send the path. No upload is necessary.
- Web picker: add an `accept` value that includes `video/*`.
- `AttachmentChips.svelte`: show a poster frame and the duration for videos. Open
  the player in the existing lightbox.
- `UserMessageBubble.svelte`: show video attachments with the player. Do not
  treat "has `hostPath`" as "is an image".
- New `components/ui/VideoPlayer.svelte` (importers: bubble, lightbox, markdown,
  evidence card). Put the logic in `ui/lib/video-player.ts`:
  - `preload="none"` until an IntersectionObserver reports the element as visible
  - pause on `visibilitychange`, because every tab stays mounted
  - keep `currentTime` when the signed URL is renewed
  - error state with Retry
- `MarkdownImage.svelte`: when the resolved path or asset has a video MIME type,
  show `VideoPlayer` instead of `<img>`. Then `![caption](/abs/path.mp4)` in an
  agent reply plays inline.

### Persistence

File attachments now exist only as prompt text, so a reload loses the chip. Store
attachment metadata (`name`, `mimeType`, `size`, `hostPath`) with the user message
for both providers, so that a video attachment is restored after a reload.

## Phase 2 — browser recordings on the host

### Model

A recording is a **server-side frame watcher** on a browser page. The registry
already sends one screencast to client watchers. The recorder is one more watcher:

- No second screencast, which Chromium would refuse.
- One path for the headless Playwright host and the desktop webview host,
  because both are `BrowserSurfaceDriver`s.
- A recording continues when the page moves between hosts, because the registry
  already restarts the stream on the new driver.
- A remote client, a phone, or an agent with no client can record.

`packages/server/src/browser/browser-recorder.ts` owns the recording:

- It subscribes to frames with a reserved watcher id. While a recording is
  active, the stream uses recording caps (viewport device pixels, maximum
  1920 px, JPEG quality 80). Otherwise it uses the viewer caps.
- It sends each JPEG frame to the recording encoder. Chromium sends frames only
  when the page paints. The encoder draws each frame on a canvas, and
  `canvas.captureStream(25)` + `MediaRecorder` keeps the timeline correct between
  paints.
- Limits: one recording per page, 5 minutes, 50 MB. At a limit, the recorder
  stops and saves the recording. It does not discard it.
- The finished MP4 goes into the content-addressed asset store
  (`writeAssetUpload`) with a `.mp4` id, so `publishAsset` accepts it.
- While a recording is active, the registry injects a small guest script (next to
  `annotation-script.ts`). It draws a ripple for each pointer press and a chip for
  each key press, so clicks and keys from both users and agents appear on the
  video. The recorder removes the script when it stops.

### Recording encoder

The encoder is a host capability, registered in the same way as
`BrowserWebviewHost` and `BrowserHeadlessHost` in `surface-driver.ts`:

```ts
interface BrowserRecordingEncoderHost {
  open(size: { width: number; height: number }): Promise<BrowserRecordingEncoder>
}
interface BrowserRecordingEncoder {
  frame(jpeg: Uint8Array): Promise<void>
  finish(): Promise<Uint8Array> // MP4 bytes
  dispose(): Promise<void>
}
```

- **Standalone server:** one Playwright Chromium browser, separate from the
  page profiles. It starts when the first recording starts and closes when the
  last one ends. Each recording gets its own blank page.
- **Desktop:** a hidden `BrowserWindow` with `backgroundThrottling: false` and
  no preload bridge. Desktop main registers it.
- The encoder page asks for `video/mp4;codecs=avc1`. When the page does not
  support it, the capability `browserRecording` is false and every entry point
  shows the reason. There is no WebM fallback; recordings use one format across clients.
- When no host is registered (for example, a server without Playwright
  Chromium), `browserRecording` is false and shows the same "install the browser
  runtime" message that the headless host shows.

### Contracts

- `BrowserPage.recording: { startedAt: string; startedBy: 'user' | 'agent' } | null`
  goes out on the existing page topic. Every client sees the same state.
- RPC `browserRecordingStart({ browserPageId })` and
  `browserRecordingStop({ browserPageId, fileTo? }) → { assetId, durationMs, sizeBytes }`.
- Transcript event `browser_recording_captured`, which has the same shape as
  `browser_snapshot_captured` plus `durationMs`.
- `BrowserEvidence` accepts video assets. `attachEvidence` already sends pull
  request files through `publishAsset`. Only the Markdown changes: a video is a
  bare URL on its own line, because GitHub shows a player for that and ignores
  alt text for video.

### Entry points

- **Browser pane toolbar:** a Record button, then a red dot with the elapsed time
  and a Stop button. Keybinding `opt+R` in the pane. When recording stops,
  Solus attaches the recording to the active composer and moves focus to the
  input.
- **Command palette:** "Start recording" and "Stop recording" for the focused
  browser page.
- **Agent tools** (`browser-tools.ts`), in the Browser tool group:
  - `browser_record_start({ browserPageId })`
  - `browser_record_stop({ browserPageId, attach_to_task_id?, attach_to_pr_number?, caption? })`
    returns the host path and a Markdown line that the agent can paste.
    It emits `browser_recording_captured`, so the user sees the recording
    without depending on the agent's reply. This is the same rule
    `browser_snapshot` follows.
- **Reverse states:** Stop in the toolbar, the palette, and the tool. Closing the
  page stops and saves. A reload shows the active recording from `BrowserPage`.

### Clients

The recorder runs on the host, so desktop, web, and mobile get the same
capability. The mobile client shows the Record control in the browser pane
toolbar with a 44 px touch target. No client uses `getDisplayMedia`.

### Retention

Keep only recordings filed on a task or a pull request.

- When a recording is filed, record a reference from the task comment or
  evidence entry to the asset id.
- A sweep on host start and every 6 hours deletes recording assets that have no
  reference and are older than 24 hours. The 24 hours give the user time to file
  or send a recording that they just made.
- A recording that the user sends as a prompt attachment is a copy in the
  session attachment bucket, so the sweep does not break the transcript.
- Deleting the last task comment that refers to a recording makes it eligible
  for the sweep. The copy on GitHub is GitHub's to keep.

## Agent instructions

### Current state

- `system-hint.ts` (`buildSystemPrompt`) holds only the user's extra and model
  instructions.
- Codex gets `codex-collaboration-instructions.ts`, which is already a copy of
  t3code's instructions:
  - Plan and Default collaboration modes
  - the Solus collaborative browser block (omitted when browser tools are off)
  - `<runtime_info>` with harness, model, and effort
- **Claude gets none of this.** It has no runtime info and no browser guidance.
- The task work contract (`task-context.ts`) does not ask the agent to link pull
  requests.

### Change

Add `packages/server/src/agents/runtime-instructions.ts`, with the only shared
copy of the host facts. Both backends use it: Claude through
`systemPrompt.append`, and Codex at the end of its collaboration instructions.
It contains:

1. `<runtime_info>`: the harness, the model, and the effort (mention only if
   asked), and "You can embed images and videos in your response with Markdown
   and absolute file paths. Solus shows them inline." Phase 1 makes this true.
2. The Solus collaborative browser block, moved out of the Codex file. It is
   omitted when the Browser tool group is off. Claude gets it for the first time.
3. The Plan and Default mode text stays Codex-only. Claude Code has its own plan
   mode.

`system-hint.ts` stays user-only. Update its comment: host runtime facts belong
to `runtime-instructions.ts`, and tool-specific guidance stays with its tool.

### Pull request linking

t3code asks the agent to call `link_pull_request` for every pull request that it
creates or works on. The reason is that t3code cannot see pull requests that the
agent creates with `gh`, with `gh stack`, or through the API. Without the link, the
thread does not show the pull request, its checks, or its review state. The
instruction also asks the agent to link every layer of a stack, to check the
list before it finishes, and to report a failed link instead of claiming
success.

Solus has most of this without agent help:

- `pr-link-discovery.ts` polls each task session's isolated-checkout branch and
  links the pull request it finds.
- `worktree-handlers.ts` and `provider-handlers.ts` link pull requests that
  Solus creates.
- The gaps are sessions not in an isolated checkout, stacked pull requests on
  other branches, and existing pull requests that the agent works on.

So Solus adds one work-contract line in `task-context.ts`, only when the session
belongs to a task:

> Link each pull request that you create or work on for this task with
> link_task (kind=pr), including every layer of a stack. Linking an
> already-linked pull request is safe. If linking fails, report it.

## Providers

- Claude and Codex: a video reaches both as a path. Neither gets video content
  blocks. The recording tools are Solus tools, so both providers have them.
- Runtime instructions: after this change, both providers get the same host
  facts. Only the collaboration-mode text is Codex-only, because it replaces a
  Codex feature.

## Connection modes

- Desktop with a local host: the desktop registers the hidden-window encoder.
- Remote and standalone servers: the recorder and the encoder run where the
  browser runs. The client only plays signed asset URLs.
- A client never gets a host path that it must open. It always gets a signed URL.

## Tests

- `videoMimeType`: MIME wins over extension, and the extension is used only for
  empty or generic MIME types.
- Upload route: wrong `Content-Length` is refused, an expired token is refused,
  and a failed stream leaves no partial file.
- Asset serving: `video/mp4` is inline with range support, and an unknown binary
  still downloads.
- Recorder, with a fake driver and a fake encoder, and no timing sleeps:
  - the limit stops and saves
  - a driver swap during a recording continues the same file
  - removing the last client watcher does not stop the stream while a recording
    is active
- Encoder: one integration test with Playwright Chromium, skipped when it is not
  installed. It checks that the output starts with an MP4 `ftyp` box.
- Tools: `browser_record_stop` emits `browser_recording_captured` and files
  evidence. A pull request target calls `publishAsset` with the `.mp4` asset.
- Retention: a filed recording survives the sweep, and an unfiled recording
  older than 24 hours is deleted.
- Runtime instructions: Claude and Codex get the same runtime block, and the
  browser block is absent when the Browser tool group is off.
- Task context: the pull request linking line appears only for task sessions.

## Open questions

None.
