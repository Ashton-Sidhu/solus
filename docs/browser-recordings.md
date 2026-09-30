# Browser recordings and video attachments

Solus can record a browser page as an MP4 video. The host records the page, so
the desktop, web, and mobile clients have the same controls. A client does not
capture its own screen.

## Record a page

1. Open a page in the browser pane.
2. Select **Record** (the circle) in the pane toolbar, or press `⌥R` while the
   pane has focus.
3. Use the page. Clicks and key presses show on the video.
4. Select **Stop** (the square), or press `⌥R` again.

While a page records, the toolbar shows a red dot and the elapsed time. Every
client that shows the page shows the same state.

The Record control stays disabled while the previous recording is being saved.

When the recording stops, Solus attaches the MP4 to the message you are writing
and moves the focus to the input. You can then send it to the agent.

To file the recording, select the arrow next to **Stop** and select a task or a
pull request. Solus stops the recording, files it, and also attaches it to the
message. The menu shows only destinations that apply to the page: the pull
request of the page's branch, and the open tasks of the page's project.

The command palette also has **Start recording** and **Stop recording** for the
page that the browser pane shows.

On a phone or tablet, the Record and Stop controls are in the same toolbar and
have a 44 px touch target.

## Limits

- One recording at a time for each page.
- A recording stops after 5 minutes or at 50 MB.
- When a limit stops a recording, or when the page closes, Solus keeps the
  video. The client that started the recording attaches it to the message.
  The video card tells why it stopped early.

The Record control is disabled, with the reason in its tooltip, when:

- The host cannot record. The host needs the browser runtime. See
  [Browser on a Linux server](linux-browser.md).
- DevTools are open on the page. Close DevTools to record.

## Recordings by an agent

Agents have two tools in the Browser tool group:

- `browser_record_start` starts a recording of a page.
- `browser_record_stop` stops it and saves the MP4. It can file the recording on
  a task (`attach_to_task_id`) or a pull request (`attach_to_pr_number`).

When an agent stops a recording, the conversation shows a video card at once.
The card does not depend on the agent's reply.

While an agent records, the toolbar shows **Agent is recording**. You can stop
the recording from the toolbar, the palette, or `⌥R`.

## Filing on tasks and pull requests

- **Task:** Solus adds the video to a task comment. It plays in Solus and stays
  on the host.
- **Pull request:** Solus uploads the video to GitHub first, because a pull
  request cannot play a file that is on the host. GitHub accepts videos up to
  10 MB when the repository owner has a Free plan, and up to 100 MB on paid
  plans. Solus cannot see the plan before it uploads, so it tries. If GitHub
  refuses the video, the recording stays on the host and Solus shows GitHub's
  reason. Uploading needs write access to the repository.

PR and task descriptions and comments use the shared video player for standalone
video URLs and image-style video embeds. MP4, M4V, MOV, WebM, and GitHub
attachment URLs play inline. Labelled links remain links. The player loads
metadata near the screen, pauses when hidden, and provides Retry and Open if
playback fails. The source link remains below the player.

Playback depends on the client's codec support and access to the URL. Private
GitHub attachments can need a signed-in browser; the player does not supply
GitHub credentials. WebM with VP8 or VP9 is supported on iOS and iPadOS starting
with Safari 17.4 ([WebKit release notes](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/)).
Solus recordings remain MP4; uploaded WebM files are not converted.

## Retention

- Solus keeps a recording that is filed on a task or a pull request.
- Solus keeps a recording that you send to an agent in a message, because the
  conversation refers to it.
- Solus deletes any other recording 24 hours after you make it. The host checks
  when it starts and every 6 hours.

## Video attachments

You can send a video to an agent in the same ways as an image:

- Drag the file onto the input.
- Paste it.
- Select it with the attachment picker.

Solus accepts MP4, M4V, MOV, and WebM files up to 50 MB. Images stay limited to
10 MB. The chip shows upload progress, and **Retry** if the upload fails.
Cancelled uploads and unused upload URLs do not spend an attachment slot.
If the host saved a file but the client lost the reply, Retry uses that file.

Videos pause when their player leaves the screen or their Solus tab is hidden.

The agent receives the video as a file path on its host. The agent can read the
file with its own tools.
