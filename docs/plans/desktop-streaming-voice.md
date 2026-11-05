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
model's default 5.6 s left context, 1.04 s chunk, and 1.04 s lookahead. Partial
text is returned by the RPC and displayed while recording. The preview replaces
the waveform once text arrives. Stable words retain their normal color;
tentative words use a muted color and can change on the next model update.
The composer keeps its draft intact until the final transcript is inserted or
sent once. Cancel clears the preview, and late stream replies cannot restore it.
Desktop and web share this behavior in the conversation composer, prompt
composers, prose editors, and text fields. CPU fallback keeps the waveform and
returns text after recording stops; it does not produce live partial text.

The helper retains the audio and uses whole-clip inference if streaming is
unsupported, fails, or returns no text. If the worker or transport fails, the
renderer retries its complete clip through `transcribeAudio`. Errors retain
that clip for the existing explicit retry. Cancellation suppresses late text.
Recordings remain limited to 60 minutes. The idle worker releases its model
after two minutes.

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
