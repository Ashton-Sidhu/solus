# Test video attachments and browser recordings

Start with the 10-minute smoke test. Then use the coverage table to test the same flow on other clients and hosts. Check a box only after the expected result is observed.

Implementation notes: [Browser recordings](../browser-recordings.md).

## Prepare

- Run a version of Solus that includes the implementation and review fixes. Restart or rebuild through your normal workflow if the running app is older than the source changes.
- Use a test project and a disposable Solus data directory for development runs. Do not run development code against your normal desktop data or `~/.solus`.
- Open a test page in the Solus browser pane. Choose one with a menu, a text field, and a visible animation.
- Prepare a valid MP4 under 10 MB and a valid video between 20 and 50 MB. Use a video with sound for the attachment playback test. Renaming a text file to `.mp4` does not make it a valid video.
- For filing tests, use a test task and an existing test PR where you can post comments. These tests create real comments.

Browser recordings capture the page. Do not expect microphone or page audio in a new browser recording.

## 1. Quick smoke test — about 10 minutes

Use desktop first, because the desktop encoder was not exercised in the earlier integrated test.

| Done | Action | Expected result |
|---|---|---|
| ☐ | Pick the short MP4 with the attachment button. | A video chip appears with a preview and duration. |
| ☐ | Open the chip, play, seek, and pause. Close the player with Esc. | Video and its existing audio play. Seeking works. Focus returns to the composer. |
| ☐ | Type “Video attachment test” and send it. | The sent message has a player. The task/session title uses the typed text. |
| ☐ | Ask the agent: “State the attached file path and confirm that the file exists. Do not modify it.” | The agent gets a file path on its host. This checks file delivery; it does not prove that the model can watch video. |
| ☐ | Play the sent video, then switch to a different Solus conversation tab **while it is playing**. Return. | Playback has paused. The position is retained. No audio continues from the hidden tab. |
| ☐ | Reload the client and reopen the conversation. | The video attachment still appears and plays. |
| ☐ | Open the test page in the browser pane. Select Record. | The toolbar shows Recording and elapsed time. |
| ☐ | Open a menu, type a few characters, wait briefly, then select Stop. | One MP4 chip appears. Focus returns to the composer. |
| ☐ | Play that recording. | It shows the actions in order, including the pause. Click indicators appear. The duration is close to the time recorded. |
| ☐ | Make another short recording. Use the arrow beside Stop to file it on the test task. | The task comment has a playable video. The composer also has the recording. |

**Stop the smoke test and report a failure** if a video is lost, playback fails, a save hangs, or a hidden tab keeps playing.

## 2. Client and host coverage

Repeat the smoke test on each available combination. Use a fresh recording for each row.

| Done | Client → host | What this proves |
|---|---|---|
| ☐ | Desktop → local desktop host | Native picker, local file playback, hidden-window encoder, webview recording. |
| ☐ | Desktop → standalone remote host | Local files upload to the selected remote host. |
| ☐ | Web → standalone host | Signed upload and playback URLs work without Electron. |
| ☐ | Real phone/tablet → standalone host | Touch controls, playback, rotation, and reconnect behavior. A narrow desktop window proves layout only. |
| ☐ | Web or desktop → host through Uplink | A valid 20–50 MB video uploads and plays through the tunnel. Verify that the connection uses Uplink, not a direct LAN route. |

On a phone, check that Stop and its filing arrow can be tapped separately. Check that the toolbar does not overlap at portrait width.

Check chips, controls, and error text once in both light and dark mode.

## 3. Upload failures and playback

| Done | Action | Expected result |
|---|---|---|
| ☐ | Pick, drop, and paste a video where the client supports those actions. | Each path produces the same usable attachment. |
| ☐ | Upload the large video to a remote host. | Progress appears. Send stays blocked until the host confirms completion. |
| ☐ | Disconnect the test client during upload; reconnect and select Retry. | The error is visible. Retry completes and the video plays. |
| ☐ | Remove a chip during upload. Then upload a fresh video. | The removed upload stops. No late error or chip returns. The new upload succeeds. |
| ☐ | Repeat cancellation in a fresh test conversation without keeping successful uploads. | Cancelled attempts do not exhaust the conversation's upload slots. |
| ☐ | Attach a video larger than 50 MB. | A size error appears. No unusable attachment is sent. |
| ☐ | Attach a non-video file larger than 10 MB. | The client refuses it with a size error. |
| ☐ | Play a video, then scroll its player out of view. | It pauses. It can be played again when brought back into view. |
| ☐ | Open the same sent message on a second client connected to that host. | The video plays there too; it does not depend on the first client's filesystem. |

The lost-success-response case is covered by a deterministic unit test: the host saves a file, the client retries the same token, and the host returns success without replacing the file. There is no need to reproduce that precise network timing by hand.

## 4. Recording controls and lifecycle

| Done | Action | Expected result |
|---|---|---|
| ☐ | Start and stop through the command palette. | One recording is attached and focus returns to the composer. |
| ☐ | Focus the browser toolbar and use ⌥R to start and stop. | It performs the same action as the controls. |
| ☐ | Stop, then try Record again while the file is being saved. | Record remains disabled until saving finishes. No duplicate chip appears. |
| ☐ | Start from one client and view the page from another. Stop from the second client. | Both clients show the recording state. The stopping client gets a playable file. |
| ☐ | Resize or change the device preset during recording. | The video contains both states without distortion; unused space can be black. |
| ☐ | Navigate or reload the test page during recording. | Recording continues and input indicators return on the new page. |
| ☐ | Close the page while it records. | The client that started it receives the saved file and a reason for the early stop. |
| ☐ | Record for five minutes. | It stops by itself, saves a playable file, and reports the duration limit. |
| ☐ | Open DevTools before starting. | The Record control is disabled with a reason. |
| ☐ | Try a host without the required recording runtime. | The feature reports why it cannot record. It must not leave a false Recording state or a permanent spinner. |

Known limitation: ⌥R is not forwarded from inside the desktop webview. Click the browser toolbar first, or use Stop/the command palette. Record this as a known gap, not a new regression.

A host shutdown currently loses a recording that is still running. Stop before restarting the host.

The 50 MB recording limit, startup/stop races, encoder failure cleanup, and encoder-pool replacement have focused unit tests. Do not generate a huge recording solely to hit that size limit.

## 5. Claude and Codex

Run this in a test session for **each provider**, with Browser tools enabled:

> Use the already-open test page in the Solus browser. Start a recording with browser_record_start, open the menu, then stop with browser_record_stop. Show the saved recording in your reply. Do not file it on a task or pull request.

Check:

- [ ] The toolbar identifies an agent recording.
- [ ] The agent uses the Solus recording tools.
- [ ] Stop produces a recording card with a playable video.
- [ ] The agent's Markdown video embed plays inline.
- [ ] Reload preserves the recording card.

In a separate run, stop the agent's recording yourself. The file must reach your composer. The agent's later Stop may report that the page is no longer recording; it must not create another recording or lose the saved file.

## 6. Task and PR filing

- [ ] File a fresh recording on a test task with the Stop menu. Open the task and play the comment's video.
- [ ] File a short recording on an existing test PR. Open GitHub and confirm that the comment contains a playable video and the caption.
- [ ] Test a filing refusal with a suitable test repository/account. The error must explain the refusal, and the saved video must remain available in the composer.
- [ ] Repeat filing through `browser_record_stop` with `attach_to_task_id` or `attach_to_pr_number`. The agent result must distinguish a saved file from a successful filing.

Do not assume a GitHub size limit from the client alone. If GitHub refuses the upload, record its actual error.

## 7. Retention — disposable data only

Create three recordings: leave one unsent and unfiled, send one in a message, and file one on a task.

- [ ] Inspect `<test data dir>/state/browser-recordings.json`. The unsent/unfiled recording has `filed: false`; the other two have `filed: true`.
- [ ] For a long-running test, wait until the unfiled recording is older than 24 hours, then allow the next sweep or restart the test host. Only the unfiled recording should be removed.
- [ ] The sent and filed recordings still play.

The host sweeps at startup and every six hours. Reading the index confirms the retention mark; it does **not** prove deletion. The unit tests verify deletion without waiting or changing the system clock.

## 8. Focused automated checks

From the repository root, run:

```sh
bun scripts/test-unit.ts \
  browser-recorder.test.ts \
  browser-recording-pool.test.ts \
  browser-recording-tools.test.ts \
  browser-recording-card.test.ts \
  browser-registry.test.ts \
  browser-store.test.ts \
  attachment-upload.test.ts \
  attachment-upload-http.test.ts \
  video-player.test.ts \
  video-mime-type.test.ts \
  artifact-protocol.test.ts \
  asset-upload.test.ts \
  asset-url-cache.test.ts \
  markdown-image.test.ts \
  runtime-instructions.test.ts \
  session-transcript-rehydration.test.ts \
  socket-io-transport.test.ts
```

Expected: **17 passed, 0 failed files**. The runner isolates each test file and uses disposable data. This command excludes the real Chromium encoder test and does not launch the app.

At the end of the review, these 17 files and targeted lint passed. Broader TypeScript/Svelte checks reported errors outside the changed files.

Earlier source-run checks covered standalone recording and web playback with mock agents. They do not replace checks of the reviewed code on desktop, a real phone, real providers, GitHub, and a real Uplink tunnel. Those integrated checks remain open.

## Failure report

Copy this for each failure:

```text
Test row:
Result: PASS / FAIL / NOT RUN
Solus version or source revision:
Client: desktop / web / phone (OS and browser)
Host: desktop-local / standalone / Uplink
Provider: Claude / Codex / not applicable
Steps:
Expected:
Actual:
Exact error:
File format and size:
Did the recording/file survive?
Evidence: screenshot, recording, or relevant log excerpt
```

Use an OS screenshot or recording if Solus recording itself fails. Include a short, relevant log excerpt; omit credentials and signed upload/playback URLs.
