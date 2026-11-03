"""Profile CPU inference through transcribe.cpp 0.4.1, without starting Solus."""

import argparse
import array
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import platform
import time
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--library", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--audio", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--threads", default="1,2,3,4,6,8,0")
parser.add_argument("--seconds", type=int, default=11)
parser.add_argument("--repeats", type=int, default=5)
parser.add_argument("--kv", choices=["auto", "f32", "f16"], default="auto")
options = parser.parse_args()
thread_counts = list(map(int, options.threads.split(",")))
if options.seconds < 1 or options.repeats < 1 or min(thread_counts) < 0:
    parser.error("Use positive seconds/repeats and non-negative thread counts")
library = c.CDLL(str(Path(options.library).resolve()))


class BackendParams(c.Structure):
    _fields_ = [("size", c.c_uint64), ("directory", c.c_char_p), ("mask", c.c_uint32)]


class SessionParams(c.Structure):
    _fields_ = [
        ("size", c.c_uint64),
        ("threads", c.c_int),
        ("kv", c.c_int),
        ("context", c.c_int32),
    ]


class Timings(c.Structure):
    _fields_ = [("size", c.c_uint64)] + [
        (name, c.c_float) for name in ["load_ms", "mel_ms", "encode_ms", "decode_ms"]
    ]


def bind(name, arguments, result=c.c_int):
    function = getattr(library, "transcribe_" + name)
    function.argtypes = arguments
    function.restype = result
    return function


version = bind("version", [], c.c_char_p)().decode()
if version != "0.4.1":
    raise RuntimeError("This benchmark requires the pinned transcribe.cpp 0.4.1 ABI")
abi_size = bind("abi_struct_size", [c.c_int], c.c_size_t)
for kind, shape in [(15, BackendParams), (1, SessionParams), (5, Timings)]:
    if abi_size(kind) != c.sizeof(shape):
        raise RuntimeError("Native struct layout differs from this benchmark")
status_string = bind("status_string", [c.c_int], c.c_char_p)


def check(status):
    if status:
        raise RuntimeError(status_string(status).decode())


backend = BackendParams()
bind("backend_init_params_init", [c.POINTER(BackendParams)], None)(c.byref(backend))
backend.mask = 1  # Register only CPU, even if the package includes Vulkan.
check(bind("init_backends_ex", [c.POINTER(BackendParams)])(c.byref(backend)))
load = bind("model_load_file", [c.c_char_p, c.c_void_p, c.POINTER(c.c_void_p)])
free_model = bind("model_free", [c.c_void_p], None)
init_params = bind("session_params_init", [c.POINTER(SessionParams)], None)
create = bind(
    "session_init", [c.c_void_p, c.POINTER(SessionParams), c.POINTER(c.c_void_p)]
)
free_session = bind("session_free", [c.c_void_p], None)
run = bind("run", [c.c_void_p, c.POINTER(c.c_float), c.c_int, c.c_void_p])
full_text = bind("full_text", [c.c_void_p], c.c_char_p)
init_timings = bind("timings_init", [c.POINTER(Timings)], None)
get_timings = bind("get_timings", [c.c_void_p, c.POINTER(Timings)])
with wave.open(options.audio, "rb") as audio_file:
    if (
        audio_file.getframerate(),
        audio_file.getnchannels(),
        audio_file.getsampwidth(),
    ) != (16000, 1, 2):
        raise RuntimeError("Expected 16 kHz mono signed 16-bit PCM WAV")
    audio = array.array("h", audio_file.readframes(audio_file.getnframes()))
if not audio:
    raise RuntimeError("Audio fixture is empty")
samples = (c.c_float * (16000 * options.seconds))(
    *[audio[i % len(audio)] / 32768 for i in range(16000 * options.seconds)]
)
rows = []
model = c.c_void_p()
check(load(os.fsencode(options.model), None, c.byref(model)))
try:
    for threads in thread_counts:
        # One excluded warm-up for each setting; sessions rotate as in Solus/Hex.
        for repeat in range(options.repeats + 1):
            params = SessionParams()
            init_params(c.byref(params))
            params.threads = threads
            params.kv = {"auto": 0, "f32": 1, "f16": 2}[options.kv]
            session = c.c_void_p()
            started = time.perf_counter()
            check(create(model, c.byref(params), c.byref(session)))
            try:
                check(run(session, samples, len(samples), None))
                elapsed = (time.perf_counter() - started) * 1000
                timings = Timings()
                init_timings(c.byref(timings))
                check(get_timings(session, c.byref(timings)))
                transcript = full_text(session).decode()
                if not transcript.strip():
                    raise RuntimeError("Speech fixture returned no transcript")
                row = dict(
                    threads=threads,
                    repeat=repeat,
                    warmup=repeat == 0,
                    total_ms=elapsed,
                    mel_ms=timings.mel_ms,
                    encode_ms=timings.encode_ms,
                    decode_ms=timings.decode_ms,
                    transcript=transcript,
                )
                rows.append(row)
                print(json.dumps(row), flush=True)
            finally:
                free_session(session)
finally:
    free_model(model)
with open(options.model, "rb") as model_file:
    model_hash = hashlib.file_digest(model_file, "sha256").hexdigest()
Path(options.output).write_text(
    json.dumps(
        dict(
            platform=platform.platform(),
            version=version,
            seconds=options.seconds,
            model_sha256=model_hash,
            kv=options.kv,
            environment={
                key: value
                for key, value in os.environ.items()
                if key
                in {
                    "TRANSCRIBE_NO_FLASH",
                    "GGML_CPU_DISABLE_FUSION",
                    "TRANSCRIBE_CONV_NO_DIRECT_DW",
                }
            },
            results=rows,
        ),
        indent=2,
    )
)
