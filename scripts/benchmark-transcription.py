# Benchmark only the native helper. Does not start Solus or read its data.
# Requires Python 3.11+. Feed 250 ms PCM chunks; --pace simulates capture time.
import argparse, subprocess, struct, json, wave, array, time, platform, hashlib
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--binary", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--audio", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--repeats", type=int, default=5)
parser.add_argument("--pace", action="store_true")
parser.add_argument("--durations", default="11,60,120")
parser.add_argument("--expect-mode", choices=["streaming", "buffered"])
options = parser.parse_args()
audio_file = wave.open(options.audio, "rb")
assert (
    audio_file.getframerate(),
    audio_file.getnchannels(),
    audio_file.getsampwidth(),
) == (16000, 1, 2)
audio = [
    v / 32768 for v in array.array("h", audio_file.readframes(audio_file.getnframes()))
]
audio_file.close()
results = []
with open(options.output + ".native.log", "wb") as log:
    worker = subprocess.Popen(
        [options.binary, options.model],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=log,
    )
    request_id = 0

    def request(op, samples=[]):
        global request_id
        request_id += 1
        started = time.perf_counter()
        worker.stdin.write(
            struct.pack("<III", op, request_id, len(samples))
            + struct.pack("<%sf" % len(samples), *samples)
        )
        worker.stdin.flush()
        line = worker.stdout.readline()
        if not line:
            raise RuntimeError("Helper exited without a reply")
        response = json.loads(line)
        if response["id"] != request_id:
            raise RuntimeError("Native reply belongs to another request")
        if response["error"]:
            raise RuntimeError(response["error"])
        return response, (time.perf_counter() - started) * 1000

    def memory_mb():
        try:
            if platform.system() == "Windows":
                import ctypes

                class Counters(ctypes.Structure):
                    _fields_ = [
                        ("cb", ctypes.c_ulong),
                        ("PageFaultCount", ctypes.c_ulong),
                    ] + [
                        (n, ctypes.c_size_t)
                        for n in [
                            "PeakWorkingSetSize",
                            "WorkingSetSize",
                            "QuotaPeakPagedPoolUsage",
                            "QuotaPagedPoolUsage",
                            "QuotaPeakNonPagedPoolUsage",
                            "QuotaNonPagedPoolUsage",
                            "PagefileUsage",
                            "PeakPagefileUsage",
                        ]
                    ]

                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.restype = ctypes.c_void_p
                handle = kernel.OpenProcess(0x410, False, worker.pid)
                c = Counters()
                c.cb = ctypes.sizeof(c)
                ctypes.WinDLL("psapi").GetProcessMemoryInfo(
                    ctypes.c_void_p(handle), ctypes.byref(c), c.cb
                )
                kernel.CloseHandle(ctypes.c_void_p(handle))
                return round(c.WorkingSetSize / 1048576, 1)
            return round(
                int(
                    subprocess.check_output(
                        ["ps", "-o", "rss=", "-p", str(worker.pid)]
                    ).strip()
                )
                / 1024,
                1,
            )
        except Exception:
            return None

    try:
        _, load_ms = request(0)
        for duration in map(int, options.durations.split(",")):
            samples = (audio * ((duration * 16000 + len(audio) - 1) // len(audio)))[
                : duration * 16000
            ]
            for repeat in range(options.repeats):
                _, begin_ms = request(1)
                started = time.perf_counter()
                feeds = []
                partials = 0
                first_partial = None
                for i in range(0, len(samples), 4000):
                    if options.pace:
                        delay = started + (i + 4000) / 16000 - time.perf_counter()
                        if delay > 0:
                            time.sleep(delay)
                    response, ms = request(2, samples[i : i + 4000])
                    feeds.append(ms)
                    if response["stable"] or response["tentative"]:
                        partials += 1
                        if first_partial is None:
                            first_partial = (time.perf_counter() - started) * 1000
                final, finish_ms = request(3)
                stream_ms = (time.perf_counter() - started) * 1000
                _, offline_ms = request(5, samples)
                result = dict(
                    seconds=duration,
                    repeat=repeat,
                    begin_ms=round(begin_ms, 2),
                    stream_compute_ms=round(stream_ms, 2),
                    finish_ms=round(finish_ms, 2),
                    feed_p95_ms=round(sorted(feeds)[int((len(feeds) - 1) * 0.95)], 2),
                    offline_ms=round(offline_ms, 2),
                    partial_updates=partials,
                    first_partial_ms=round(first_partial, 2) if first_partial else None,
                    resident_mb=memory_mb(),
                    transcript_words=len(final["transcript"].split()),
                )
                if options.expect_mode == "streaming" and partials == 0:
                    raise RuntimeError(
                        "Expected live inference, but no partial text was produced"
                    )
                if options.expect_mode == "buffered" and partials != 0:
                    raise RuntimeError(
                        "CPU fallback must not run buffered streaming inference"
                    )
                if not final["transcript"].strip():
                    raise RuntimeError("Speech fixture returned no transcript")
                result["wait_after_stop_ms"] = round(
                    max(0, stream_ms - duration * 1000) if options.pace else finish_ms,
                    2,
                )
                results.append(result)
                print(json.dumps(result), flush=True)
    finally:
        worker.stdin.close()
        try:
            worker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.wait()
report = dict(
    platform=platform.platform(),
    machine=platform.machine(),
    model_sha256=hashlib.file_digest(open(options.model, "rb"), "sha256").hexdigest(),
    fixture="whisper.cpp JFK, repeated for longer clips; artificial repetition is not an accuracy benchmark",
    paced=options.pace,
    load_ms=round(load_ms, 2),
    results=results,
)
Path(options.output).write_text(json.dumps(report, indent=2))
