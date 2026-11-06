# Desktop streaming voice

Desktop dictation uses Parakeet Unified English 0.6B Q8 through a bundled
`transcribe.cpp` helper. This replaces the desktop ONNX runtime and TDT v3
model. This change supports English only. Native mobile inference is outside
this change; web and mobile clients retain their existing host transcription
path. A standalone server does not advertise transcription.

Desktop and web show a workspace notice while the transcription host downloads
or installs its model. Download progress is visible without hovering over the
mic. The notice does not block typing. It disappears when the model is ready;
a failed download leaves a Retry button. This follows the same device-first
host selection as the microphone. Native mobile UI remains outside this change.

## Recording behavior

The microphone belongs to the client device. Desktop audio is transcribed by
the desktop's local host even when the session's agent runs on another host.
Claude and Codex receive the same resulting text; their adapters do not change.

An active desktop recording continues when the window loses focus, is hidden,
or is minimized. The existing speech and silence thresholds still stop the
recording. Stop and Cancel still work. Hiding the window does not start another
recording, and automatic voice mode does not rearm while the window is hidden.
The transcript follows the existing insert or auto-send setting.

While a stream is active, the main process prevents app suspension and disables
background throttling for the workspace window. Finish, Cancel, worker exit,
app quit, and an inactive-client timeout release both settings. A disconnected
stream is retired after 30 seconds without another feed.

## Audio and inference

The renderer captures 16 kHz mono PCM with AudioWorklet. It sends 250 ms chunks
through typed `voiceStreamStart`, `voiceStreamFeed`, `voiceStreamFinish`, and
`voiceStreamCancel` calls. Arrays have the same representation over Electron
IPC and WebSockets. Each stream has a random token and belongs to one transport
client. Another client cannot feed, finalize, or cancel it.

Feeds are serial. The renderer caps queued audio at ten seconds and retains a
separate complete clip. The native helper uses buffered streaming, with the
model's 5.6 s left context, a 560 ms chunk, and 560 ms lookahead. Preparation and
recording use the same trained window. This reduces the first-text wait without
the preparation cost of the smallest windows; see the
[latency benchmarks](../benchmarks/desktop-voice-2026-11-03.md). Partial
text is returned by the RPC and displayed while recording. Stable words retain
their normal color; tentative words use a muted color and can change on the next
model update.

The level meter receives a new RMS level every 32 ms of captured audio. This
cadence is separate from the 250 ms transcription packets and does not change
speech detection or silence timing. Levels use a plain reference and reset when
capture stops. Late callbacks cannot restore a finished recording's level.

The conversation composer and prompt composers keep the editor and its draft on
screen. Live words appear at the caret, with the separators the final transcript
will use, so the transcript replaces them in place. The words are a widget, not
document text. The editor is read-only until the recorder settles, so the words
cannot move and a half-finished draft cannot be sent. Prose editors show the same
text in a popover at the mic, and text fields show it over the field. Cancel
clears the preview, and late stream replies cannot restore it.

The inline preview retains its confirmed and tentative text nodes across model
updates. Confirmed text is appended in place; tentative text can be replaced.
Empty text nodes are retained when words become confirmed. Caret placement and
nearest scrolling remain the same. Desktop and web share this implementation;
native mobile keyboard dictation uses its existing operating-system input path.

While recording, the conversation composer's toolbar row becomes one control:
round Cancel, a level meter of real audio that fills the row, and solid round
Finish in the send corner. If a turn can be stopped, Stop keeps the corner and
Finish sits beside it. The pointer that started the recording rests over the
meter, so a second click cancels nothing. Other composers show the same controls
with a shorter meter, and Send stays there, disabled. Esc cancels. An empty
composer shows "Listening..." until the first words arrive. CPU fallback keeps the meter and
returns text after recording stops; it does not produce live partial text.
Desktop and web share this behavior.

The helper retains the audio and uses whole-clip inference if streaming is
unsupported, fails, or returns no text. If the worker or transport fails, the
renderer retries its complete clip through `transcribeAudio`. Errors retain
that clip for the existing explicit retry. Cancellation suppresses late text.
Recordings remain limited to 60 minutes. With voice mode off, the idle worker
releases its model after two minutes.

## Voice-mode preparation

When voice mode is enabled and the selected transcription host's model is ready,
the client prepares the worker before the next recording needs it. A single
app-wide hold keeps its model loaded across pauses, tab changes, and recordings.
Desktop and web use the same host-addressed `warmTranscription` request. Model
preparation is independent of the agent's host and provider. Native mobile
keyboard dictation keeps its operating-system preparation policy.

The client renews its hold every 30 seconds. The host scopes each hold to the
transport client, so one client cannot release another client's hold. Disabling
voice mode, changing transcription hosts, or unmounting the client releases its
hold. A hold with no renewal expires after 90 seconds; the usual two-minute idle
timeout then applies. Lost clients cannot retain model memory indefinitely.
Reconnects and model installation readiness cause the client to acquire again.

Preparation does not hold a sleep-prevention assertion. Concurrent warm requests
share one native request, and renewing a hold during a recording does not add
native work. Standalone hosts without transcription do not acquire a hold.
One-off dictation still warms on press and keeps the normal idle timeout.

Focused tests drive the shared client effect and host timers without opening an
app or microphone. They cover readiness and reconnects, host changes, renewals,
release on disable and unmount, ownership across clients, lease expiry,
concurrent preparation, and the one-off idle timeout.

## Native builds and distribution

Run `bun run voice:build` before using desktop voice in development. It needs
CMake 3.24+, Git, and a C++17 compiler. Set `CMAKE` to a specific CMake executable
if needed. The native build uses two compiler jobs and does not build Solus.

Electron packaging runs the same native build in `beforePack`. The helper and
its libraries ship outside `app.asar` in `resources/transcription`. Native code
is pinned to a specific `transcribe.cpp` commit and shipped with its notices.
macOS uses embedded Metal shaders. Windows and Linux release jobs install the
Vulkan SDK; Vulkan is an optional backend module, so a machine without a Vulkan
loader can still start the helper and use CPU. Windows uses a static MSVC
runtime. Linux builds target glibc, as the desktop distribution already does.

`afterPack` executes the helper's `--probe` command on the target OS and CPU.
That command loads the bundled backends and requires a CPU device. It needs no
speech model or user data. Native execution on Windows and Linux must also be
checked in their release jobs; a macOS test does not establish those results.
The x86 package includes CPU ISA variants selected at runtime. CPU capture
buffers audio; only GPU/IGPU devices run buffered streaming. GPU preparation
feeds eight seconds of silence to warm the stream graphs.

The model manifest is `resources/transcription/model.json`. A release job
mirrors its pinned Hugging Face artifact to R2, checks SHA-256, and records the
hash in object metadata before desktop builds can publish. The application
continues to download the model from `releases.solus.sh`, with checksum and
atomic-install checks. Existing ONNX cache files are left alone; they are no
longer read. `SOLUS_PARAKEET_MODEL_BASE_URL` can select a mirror for development.

## Verification in this change

Focused tests cover ordered feeds, cancellation during startup, bounded queues,
full-clip recovery admission, per-client ownership, power-assertion cleanup,
desktop hide behavior, and desktop package rules. Tests drive the real Svelte
composer effects without opening an app or microphone.

The native helper was built on an Apple M4. An 11-second public JFK sample
produced 32 partial updates, finished in 107 ms, and also passed whole-clip
inference. This is a helper smoke test, not an end-to-end microphone benchmark.
No app build, browser, or interactive microphone test was run. Subsequent
SSH benchmarks built and exercised the helper on Windows (MSVC/Vulkan and CPU)
and Linux (CPU), corrected CPU ISA dispatch and streaming policy, and compared
them with the current ONNX worker. See
[the benchmark report](../benchmarks/desktop-voice-2026-11-02.md).
