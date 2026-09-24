# Video attachments and browser recordings

Status: plan. Not implemented.

Users and agents must be able to show UI behaviour as a video. A screenshot
cannot show an animation, a flicker, a focus jump, or a race.

## Vocabulary

- **video attachment** — a video file that a user attaches to a prompt.
- **recording** — a video that Solus makes of a browser page. A recording is
  stored as an asset, and it can become a video attachment or evidence.
- **evidence** — a snapshot or recording filed on a task or a pull request
  (existing term, `browser-evidence.ts`).

Do not use "clip", "screencast", or "capture" for the video file. "Screencast"
stays the name of the live JPEG frame stream.

## Direction taken from t3code

t3code (`~/t3code`) ships video attachments and browser recordings. We copy these
decisions:

1. **A video is a `file` attachment.** There is no new attachment type. One
   helper finds videos by MIME type. It uses the file extension only when the MIME
   type is empty or generic (`application/octet-stream`).
2. **The agent gets the path.** Claude and Codex cannot watch video. The prompt
   gets the same `[Attached file: <path>]` line as other files. The agent can use
   its own tools (for example ffmpeg) when it needs frames. We do not extract
   frames in v1.
3. **Uploads stream over HTTP.** An RPC gives a signed upload token that states
   the size. The client sends the raw bytes in one `POST`. The server compares
   `Content-Length` with the token and streams to disk. Base64 over the WebSocket
   is not used for large files.
4. **The server serves video inline.** `video/*` assets use
   `Content-Disposition: inline`, with range requests.
5. **One lazy player.** A video fetches nothing until it is near the viewport. It
   pauses when the page is hidden, and it keeps the playhead when the signed URL
   is renewed.
6. **The recorder records the page, not the screen.** It cannot capture other
   windows, and macOS does not ask for screen-recording permission.
7. **Recordings show input.** Clicks and key presses appear on the video.
8. **Agents can record.** They use start and stop tools, and the result is a file
   that the agent can read.

We do one thing differently. t3code records in the desktop renderer with
`getDisplayMedia` + `MediaRecorder`, so only desktop can record. **Solus records on
the host** (see Phase 2). Then desktop, web, mobile, headless servers, and agents
use one recorder.

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
- The browser registry already sends one screencast to many watchers
  (`browser-registry.ts:740-840`). Both drivers implement
  `startScreencast` (`playwright-host.ts:477`, desktop `chromium-driver.ts`).
  Chromium allows one screencast for each page.

## Phase 1 — send and play video files

### Contracts

- Add `videoMimeType({ name, mimeType })` and `VIDEO_FILE_EXTENSIONS` in
  `packages/contracts/src/` (mp4, m4v, mov, webm). Every client and the server
  use this helper. Do not make a second copy.
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

- `attachment-upload.ts` and `ws-transport.ts`: use the token upload for files
  larger than the RPC limit, and for all videos. Show upload progress on the chip.
  Show a Retry action when the upload fails.
- Desktop with a local host: send the path. No upload is necessary.
- Mobile web: add `accept` so the picker offers the photo library, including
  videos. iOS and Android system screen recordings are sent this way.
- `AttachmentChips.svelte`: show a poster frame and the duration for videos. Open
  the player in the existing lightbox.
- `UserMessageBubble.svelte`: show video attachments with the player. Do not
  treat "has `hostPath`" as "is an image".
- New `components/ui/VideoPlayer.svelte` (second importer: bubble, lightbox,
  markdown, evidence card). Put the logic in `ui/lib/video-player.ts`:
  - `preload="none"` until an IntersectionObserver reports the element as visible
  - pause on `visibilitychange`, because every tab stays mounted
  - keep `currentTime` when the signed URL is renewed
  - error state with Retry
- `MarkdownImage.svelte`: when the resolved path or asset has a video MIME type,
  show `VideoPlayer` instead of `<img>`. Agents can then embed a recording with
  `![caption](/abs/path.webm)`.

### Persistence

File attachments now exist only as prompt text, so a reload loses the chip. Store
attachment metadata (`name`, `mimeType`, `size`, `hostPath`) with the user message
for both providers, so that a video attachment is restored after a reload.

## Phase 2 — browser recordings on the host

### Model

A recording is a **server-side frame watcher** on a browser page. The registry
already sends one screencast to client watchers. The recorder is one more watcher,
so:

- the recorder does not need a second screencast, which Chromium would refuse
- the recorder uses the same path for the headless Playwright host and the
  desktop webview host, because both are `BrowserSurfaceDriver`s
- a recording continues when the page moves between hosts, because the
  registry already restarts the stream on the new driver
- a remote client, a phone, or an agent with no client can record

`packages/server/src/browser/browser-recorder.ts` owns this:

- It subscribes to frames with a reserved watcher id. While a recording is
  active, the stream uses recording caps (full viewport device pixels, capped at
  1920 px, JPEG quality 80). Otherwise it uses the viewer caps.
- Chromium sends frames only when the page paints. The recorder writes frames at
  a constant 25 fps and repeats the last frame when no new frame arrives.
  Playwright's own recorder uses the same method.
- It encodes with ffmpeg through `image2pipe`. The output is MP4/H.264 when the
  ffmpeg build has `libx264`, otherwise WebM/VP8. It looks for ffmpeg in this
  order: `SOLUS_FFMPEG`, then `PATH`, then the ffmpeg that
  `playwright install` downloads. When there is no ffmpeg, the host capability
  `browserRecording` is false and every entry point shows the reason.
- Limits: one recording per page, 5 minutes, 50 MB. At a limit, the recorder
  stops and saves the recording. It does not discard it.
- The finished file goes into the content-addressed asset store
  (`writeAssetUpload`). The stored asset is the only result.
- While a recording is active, the registry injects a small guest script (next to
  `annotation-script.ts`). It draws a ripple for each pointer press and a chip for
  each key press, so clicks and keys from both users and agents appear on the
  video. The recorder removes the script when it stops.

### Contracts

- `BrowserPage.recording: { startedAt: string; startedBy: 'user' | 'agent' } | null`
  goes out on the existing page topic. Every client sees the same state.
- RPC `browserRecordingStart({ browserPageId })` and
  `browserRecordingStop({ browserPageId, fileTo? }) → { assetId, mimeType, durationMs, sizeBytes }`.
- Transcript event `browser_recording_captured`, which has the same shape as
  `browser_snapshot_captured` plus `mimeType` and `durationMs`.
- `BrowserEvidence` accepts video assets.

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
capability. Mobile shows the Record control in the browser pane toolbar with a
44 px touch target. No client uses `getDisplayMedia`.

## Agent instructions

Solus keeps user instructions and capability guidance apart:
`buildSystemPrompt` (`packages/server/src/agents/system-hint.ts`) contains only
the user's extra and model instructions. Its comment says capability guidance
"stays with its tool or skill". So:

- The `browser_record_*` tool descriptions tell the agent when to record: to
  show motion, timing, focus, or a flow of more than one step. A still
  screenshot is enough for layout.
- The `browser_record_stop` result gives the Markdown line to paste.
- Solus does not add a general system-prompt line. **Open decision:** a line
  like t3code's "You can embed images and videos in your response using Markdown
  with absolute file paths" would help agents that make video with their own
  tools. This line has no tool, so it breaks the rule above. To add it, we would
  have to set the `instructions` field of the Claude SDK MCP server
  (`claude-tool-adapter.ts`) and add it to Codex developer instructions.

## Providers

- Claude and Codex: a video reaches both as a path. Neither gets video content
  blocks. The recording tools are Solus tools, so both providers have them.
- Provider-specific behaviour: none.

## Connection modes

- Desktop with a local host: the recorder runs in the desktop-hosted server. The
  desktop needs ffmpeg as for any host. Check whether the packaged app includes it.
- Remote and standalone servers: the recorder runs where the browser runs. The
  client only plays signed asset URLs.
- A client never gets a host path that it must open. It always gets a signed URL.

## Tests

- `videoMimeType`: MIME wins over extension, and the extension is used only for
  empty or generic MIME types.
- Upload route: wrong `Content-Length` is refused, an expired token is refused,
  and a failed stream leaves no partial file.
- Asset serving: `video/mp4` is inline with range support, and an unknown binary
  still downloads.
- Recorder: frames are repeated to a constant rate. The limit stops and saves.
  A driver swap during a recording continues the same file. Removing the last
  client watcher does not stop the stream while a recording is active. Use a fake
  driver and a fake encoder. No timing sleeps.
- Tools: `browser_record_stop` emits `browser_recording_captured` and files
  evidence.

## Open questions

1. The general "embed media" system-prompt line (see Agent instructions).
2. Pull request evidence: snapshots are published to the repository. Do we
   publish 50 MB videos the same way, or file a link to the Solus asset?
3. Do we include ffmpeg in the desktop package, or require it on `PATH`?
4. Retention: do we delete recordings with their session, or keep them while
   evidence refers to them?
5. Does iOS Safari play the WebM/VP8 fallback on the phones we support? If not,
   require an ffmpeg with `libx264`.
