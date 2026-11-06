# Voice input delay — 2026-11-03

The main delay is in model streaming, before the editor receives words. A smaller
trained window reduces this delay. The editor can retain its text nodes, but that
change alone will not remove a wait of several seconds.

The initial investigation added benchmark tools, raw results, and an experiment-only
native patch. The approved implementation is described in the follow-up below.

## Model settings

Apple M4, 24 GiB, macOS 26.5.2. Same Q8 model and pinned transcribe.cpp runtime
as desktop. Audio arrives at recording speed in 250 ms packets. Each row is the
median of three runs of the same 11-second JFK sample. Left context stays at
5,600 ms. Both columns in the setting are model parameters, not network packets.

| Chunk / right context | First text | Typical gap between text changes | Native feed time over the clip | Wait after Stop |
| --- | ---: | ---: | ---: | ---: |
| Current: 1,040 / 1,040 ms | 3,337 ms | 1,012 ms | 941 ms | 137 ms |
| 560 / 560 ms | 1,808 ms | 743 ms | 1,517 ms | 89 ms |
| 160 / 320 ms | 1,590 ms | 316 ms | 4,352 ms | 169 ms |
| 160 / 160 ms | 1,593 ms | 413 ms | 4,565 ms | 166 ms |
| 80 / 80 ms | 1,353 ms | 259 ms | 8,566 ms | 306 ms |

First text is measured from clip time zero, including any silence in the sample.
The typical gap is the median of actual changed snapshots. Gaps include speech
pauses. Native feed time includes Python packing, pipe traffic, native work, and
reply parsing. It is not a GPU kernel profile or an energy measurement.

The 160/320 setting cuts the first-text wait by 52% and the typical update gap by
69% on this clip. It uses 4.6 times as much native feed time. The 80/80 setting
uses 9.1 times as much. Its p95 feed takes about 256 ms, slightly longer than a
250 ms capture packet. This leaves little capacity for other work.

The previous benchmark counted every nonempty reply as a partial update. The
current setting returns 32 such replies but only eight changed snapshots on this
clip. The new benchmark saves every change and its timestamp.

Raw results: [model settings](desktop-voice-2026-11-03/jfk-settings.json).

## Other speech and packet sizes

The 160/320 setting also improves the first-text wait on two other clips:

| Sample | Runs per setting | Current first text | 160/320 first text | Current typical gap | 160/320 typical gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| FLEURS English, 10.56 s | 2 | 3,330 ms | 2,340 ms | 1,013 ms | 336 ms |
| Dots speech, 35.3 s | 1 | 3,345 ms | 1,605 ms | 1,003 ms | 321 ms |

All five settings returned the same normalized words as offline inference on
JFK. Both settings returned the same normalized words as offline inference on
FLEURS and Dots. Punctuation did differ. Offline inference is a comparison, not
human ground truth. These three clips do not establish general word error rate,
accent coverage, noise tolerance, or command and code-name accuracy. There were
no committed-prefix rewrites in these runs.

With 100 ms packets, the current model's first text was 3,294 ms, compared with
3,337 ms in the 250 ms block. The 160/320 setting reached 1,557 ms, compared with
1,590 ms. These are separate serial blocks, with two runs per setting for the
100 ms control. They show a small first-text gain; they do not justify making
smaller packets the default for all connections. The typical text gap for
160/320 fell to 206 ms with 100 ms packets.

Raw results: [FLEURS](desktop-voice-2026-11-03/fleurs.json),
[Dots](desktop-voice-2026-11-03/dots.json),
[100 ms packets](desktop-voice-2026-11-03/packets.json).

## First recording after worker release

A separate single run per setting starts the audio clock before `begin`, without
an explicit warm-up or prior offline inference. Audio that arrives during worker
preparation is fed afterward. This models the existing serial queue after the
worker has been released. The file and driver caches are warm; this is not a
first-install test. Process launch, microphone permission, and transport startup
are not included.

| Chunk / right context | Preparation in begin | First text from audio start |
| --- | ---: | ---: |
| Current: 1,040 / 1,040 ms | 523 ms | 3,326 ms |
| 560 / 560 ms | 918 ms | 1,807 ms |
| 160 / 320 ms | 2,786 ms | 2,993 ms |

This strengthens the case for 560/560 as the first product experiment. The
160/320 setting wins with a prepared worker, but gives much less benefit on the
first recording. Do not add preparation and prepared-worker first-text timings:
audio capture overlaps preparation, so accumulated audio must be replayed.
The helper currently prewarms with eight seconds of silence, which repeats much
more work with smaller chunks. The 80/80 preparation took 9.58 seconds in the
prepared-worker sweep; no separate first-recording test was run for that setting.

Raw results: [first recording](desktop-voice-2026-11-03/first-recording.json).

## Network delivery

A separate test drives the real `VoiceStreamSession` with synthetic fixed request
delays. Each recording is three seconds. Requests remain serial, as in the app.

| Packet | Simulated request time | Wait after Stop |
| --- | ---: | ---: |
| 250 ms | 2 ms | 2 ms |
| 100 ms | 2 ms | 3 ms |
| 250 ms | 140 ms | 141 ms |
| 100 ms | 140 ms | 1,326 ms |

A feed service time longer than the capture interval creates a queue. Reducing
packets to 100 ms can therefore make remote dictation slower. Keep the 250 ms
transport packets while testing smaller model windows. If a later change uses
smaller local packets, it must retain a suitable remote policy and bound queues.

A synthetic JSON round trip cost about 217 microseconds for a 250 ms packet and
81 microseconds for a 100 ms packet. The rate was about 314 kB/s for both, before
transport framing. JSON conversion is much smaller than the measured model delay.
This is not an Electron IPC or WebSocket throughput measurement.

Raw results and runnable test: [transport](desktop-voice-2026-11-03/transport.json),
[transport benchmark](desktop-voice-2026-11-03/transport-bench.ts).

## Editor preview and scrolling

An isolated Chromium page ran the real CodeMirror preview at one update per
animation frame. Each case has 80 updates. The editor is 600 by 140 pixels and
wraps lines. Starting preview lengths are 20, 200, and 2,000 words; each update
adds a word. The test forces layout after each dispatch. This is a stress test,
not an app or Svelte render trace.

| Starting words | Current update p95 | Reuse text nodes, update p95 | Replacements: current / reuse |
| --- | ---: | ---: | ---: |
| 20 | 1.4 ms | 1.4 ms | 79 / 0 |
| 200 | 2.0 ms | 1.8 ms | 79 / 0 |
| 2,000 | 5.4 ms | 4.2 ms | 79 / 0 |

Reusing the widget DOM reduces replacements. The measured timing gain is small
and noisy. Frame p95 stayed near 17–18 ms for both policies. Preserve the confirmed
text node and update the tentative node in place as a small rendering improvement;
do not claim that this solves the main delay. The protocol already keeps committed
text append-only and separates tentative text. Extra text stabilization would add
delay and is not supported by this result.

Removing `scrollIntoView` did not produce a consistent speed improvement. It left
`scrollTop` at zero while the preview grew below the input area. Keep the current
`nearest` scrolling and selection behavior. Do not animate the caret or reveal
already available words one at a time.

Raw results: [preview](desktop-voice-2026-11-03/preview.json).
Runnable browser entry: [voice-preview.ts](../../tests/benchmarks/voice-preview.ts).

## Microphone feedback

`PcmCapture` groups audio into 250 ms packets. `VoiceRecorder` updates its plain
`rmsRef` only when one of these packets arrives. The waveform draws each animation
frame, but receives a new level only four times per second. This explains a
possible feedback delay independently of text inference.

A synthetic speech-onset sweep gives a median batching delay of 126 ms and a
maximum of 250 ms for the current meter. A proposed 32 ms meter window gives
17 ms and 32 ms. These are batching results, not measured microphone latency.
A 128-sample RMS calculation took roughly 0.8–1.4 microseconds in a separate
synthetic loop; it does not include worklet messages or browser scheduling.

Compute the meter level on a separate short cadence, writing the existing plain
reference. Keep transcription packets and the speech/silence thresholds separate.
This would improve immediate feedback without increasing network request rate.
Permission and device startup still need a live microphone test.

Raw results and test: [meter](desktop-voice-2026-11-03/meter.json),
[meter benchmark](desktop-voice-2026-11-03/meter-bench.ts).

## Recommended changes

1. Start with 560/560 ms as the conservative model experiment. It nearly halves
   first-text wait on JFK for about 1.6 times the native feed work.
2. Test 160/320 ms for more frequent text updates on capable GPUs. It is the
   stronger smoothness result, but its compute cost needs an explicit budget.
   Retain the current CPU whole-clip fallback. Do not use 80/80 by default.
3. Update the microphone meter on a separate short cadence. Keep 250 ms audio
   delivery for remote connections.
4. Reuse the preview DOM as a small improvement. Keep nearest scrolling and
   immediate display of available text.
5. Before changing the default, repeat first-recording checks on other GPUs, check
   broader speech accuracy and battery use, and test the full microphone path.

## Reproduce

Use Python 3.11+ and CMake 3.24+. The experiment only builds the native helper.
It does not build or start Solus. Set `MODEL` to a disposable copy of the model.
Do not run an app or server against live Solus data.

```sh
BENCH_DIR=$(mktemp -d /tmp/solus-voice-bench.XXXXXX)
git clone https://github.com/anomalyco/transcribe.cpp.git "$BENCH_DIR/upstream"
git -C "$BENCH_DIR/upstream" checkout 7045d1c0fe7cee37747b2792977421d435e75fca
mkdir "$BENCH_DIR/helper"
cp native/transcription/CMakeLists.txt native/transcription/main.cpp "$BENCH_DIR/helper/"
patch -d "$BENCH_DIR/helper" -p1 < docs/benchmarks/desktop-voice-2026-11-03/helper.patch
cmake -S "$BENCH_DIR/helper" -B "$BENCH_DIR/build" \
  -DCMAKE_BUILD_TYPE=Release -DTRANSCRIBE_METAL=ON \
  -DFETCHCONTENT_SOURCE_DIR_TRANSCRIBE="$BENCH_DIR/upstream"
cmake --build "$BENCH_DIR/build" --target solus-transcription --parallel 2
python3 scripts/benchmark-voice-latency.py \
  --binary "$BENCH_DIR/build/solus-transcription" --model "$MODEL" \
  --audio "$BENCH_DIR/upstream/samples/jfk.wav" --repeats 3 \
  --output "$BENCH_DIR/settings.json"
```

Use `--packets 100` for the packet control. Use `--cold-start --repeats 1` for
first-recording timing; this starts the audio clock before model preparation and
feeds accumulated audio afterward. The model settings are experiment-only
`BENCH_CHUNK_MS` and `BENCH_RIGHT_MS` environment variables in `helper.patch`.
The shipping helper does not have these settings. Use only trained configurations.

```sh
bun docs/benchmarks/desktop-voice-2026-11-03/transport-bench.ts /tmp/transport.json
bun docs/benchmarks/desktop-voice-2026-11-03/meter-bench.ts /tmp/meter.json
bun build tests/benchmarks/voice-preview.ts --target browser --outfile /tmp/voice-preview-bench.js
```

Load the browser bundle in an empty isolated page. Call `runVoiceBenchmark(20)`,
`runVoiceBenchmark(200)`, and `runVoiceBenchmark(2000)` serially and await each.
The function replaces page content. Never run it inside a mounted Solus client.

## Verification and limits

There were 28 paced model runs, 960 measured preview updates, four synthetic
transport cases, and two meter-window controls. The four focused voice suites passed: 18 tests and 56 assertions. The preview
and transport benchmark files passed a targeted TypeScript check and Oxlint.
The Python benchmark passed compilation. The experiment helper was compiled with
two build jobs. Benchmark child processes exited after their runs. No full app
build or dev server was started. No microphone or live session data was used.

Desktop and web share the preview and capture code. Both IPC and WebSocket paths
use serial `VoiceStreamSession` feeds. The native model experiment applies to a
desktop transcription host with a GPU. CPU behavior and Windows/Linux GPU results
were not tested here. Native mobile uses a separate composer and was not exercised;
its operating-system keyboard dictation does not use this CodeMirror preview.
Claude and Codex receive the same final transcript, so these experiments do not
change provider behavior. No RPC, persistence, or reconnect behavior was changed.

The browser test used an isolated background page, not the app. Model settings
ran in serial blocks and may be affected by cache and load drift. UI and small
synthetic CPU tests overlapped parts of the GPU run. Timing differences of a few
milliseconds must not be treated as exact improvements. The first native model
preparation also included shader/driver work and must not be presented as a stable
first-install timing.

Pinned API and trained settings:
[Parakeet extension](https://github.com/anomalyco/transcribe.cpp/blob/7045d1c0fe7cee37747b2792977421d435e75fca/include/transcribe/parakeet.h),
[model documentation](https://github.com/anomalyco/transcribe.cpp/blob/7045d1c0fe7cee37747b2792977421d435e75fca/docs/models/parakeet-unified-en-0.6b.md).
The FLEURS English fixture is attributed to Google FLEURS, CC-BY-4.0; its original
utterance id is 1904 in the pinned runtime's `samples/README.md`. File hashes and
transcript snapshots are retained in the raw results. The model hash and runtime
pin are in [environment.json](desktop-voice-2026-11-03/environment.json).

## Approved implementation follow-up

The native helper now uses 560/560 ms for both preparation and streaming. The
meter updates from 32 ms sample windows and still sends 250 ms audio packets.
The inline preview retains both text nodes, including empty nodes, so commitment
does not recreate the preview. Caret and nearest scrolling are unchanged.

A paced first-recording check of the compiled production source returned its first
text at 1,803 ms and completed 105 ms after Stop. Its normalized words matched
offline inference. This is one run on the same M4, not a new accuracy study.
The [raw check](desktop-voice-2026-11-03/implementation-check.json) includes snapshots.
The benchmark helper patch now applies to the implemented source, and the browser
benchmark retains an explicit pre-change replacement control.

Implementation validation passed 22 tests and 92 assertions, including meter
cadence, independent packet timing, level cleanup and late callbacks, empty-node
commitment, final transcript insertion, and cancellation. Targeted TypeScript
checks and Oxlint passed. No full app build or live microphone test was run.
