"""Measure paced speech-to-text changes, not repeated non-empty replies.

The experiment helper accepts BENCH_CHUNK_MS and BENCH_RIGHT_MS. The shipping
helper ignores them; use it for the production control. See the report for the
experiment patch and build commands. No Solus server or user data is opened.
"""
import argparse
import array
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import statistics
import struct
import subprocess
import time
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', required=True)
parser.add_argument('--model', required=True)
parser.add_argument('--audio', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--configs', default='1040:1040,560:560,160:320,160:160,80:80')
parser.add_argument('--packets', default='250')
parser.add_argument('--repeats', type=int, default=3)
parser.add_argument('--cold-start', action='store_true', help='Start audio before the first begin; one run and packet size per config')
options = parser.parse_args()
configs = [tuple(map(int, value.split(':'))) for value in options.configs.split(',')]
packets = list(map(int, options.packets.split(',')))
if options.repeats < 1 or any(value < 1 or value > 1000 for value in packets):
    parser.error('Use positive repeats and packet lengths from 1 to 1000 ms')
if options.cold_start and (options.repeats != 1 or len(packets) != 1):
    parser.error('--cold-start requires --repeats 1 and one packet size')
with wave.open(options.audio, 'rb') as source:
    if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (16000, 1, 2):
        parser.error('Expected 16 kHz mono 16-bit WAV')
    audio = [value / 32768 for value in array.array('h', source.readframes(source.getnframes()))]


def percentile(values, fraction):
    return sorted(values)[int((len(values) - 1) * fraction)] if values else None


def words(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower())


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        next_row = [i]
        for j, y in enumerate(b, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (x != y)))
        row = next_row
    return row[-1]


rows = []
for chunk_ms, right_ms in configs:
    environment = dict(os.environ, BENCH_CHUNK_MS=str(chunk_ms), BENCH_RIGHT_MS=str(right_ms))
    log_path = f'{options.output}.{chunk_ms}-{right_ms}.log'
    with open(log_path, 'wb') as log:
        worker = subprocess.Popen([options.binary, options.model], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=log, env=environment)
        request_id = 0

        def request(operation, samples=()):
            global request_id
            request_id += 1
            start = time.perf_counter()
            worker.stdin.write(struct.pack('<III', operation, request_id, len(samples))
                               + struct.pack(f'<{len(samples)}f', *samples))
            worker.stdin.flush()
            line = worker.stdout.readline()
            if not line:
                raise RuntimeError(f'Helper exited; see {log_path}')
            reply = json.loads(line)
            if reply['id'] != request_id or reply['error']:
                raise RuntimeError(reply)
            return reply, (time.perf_counter() - start) * 1000

        try:
            warm_ms = 0
            reference = None
            offline_ms = None
            if not options.cold_start:
                _, warm_ms = request(0)
                reference, offline_ms = request(5, audio)
            for repeat in range(options.repeats):
                # Alternate packet order so later packets do not always benefit
                # from warmer caches. Model configs still run serial blocks.
                for packet_ms in packets[::1 if repeat % 2 == 0 else -1]:
                    started = time.perf_counter()
                    _, begin_ms = request(1)
                    if not options.cold_start:
                        started = time.perf_counter()
                    previous = ('', '')
                    changes, feeds = [], []
                    stable_rewrites = 0
                    packet_samples = packet_ms * 16
                    for offset in range(0, len(audio), packet_samples):
                        samples = audio[offset:offset + packet_samples]
                        delay = started + (offset + len(samples)) / 16000 - time.perf_counter()
                        if delay > 0:
                            time.sleep(delay)
                        reply, feed_ms = request(2, samples)
                        elapsed = (time.perf_counter() - started) * 1000
                        feeds.append(feed_ms)
                        current = (reply['stable'], reply['tentative'])
                        if current != previous:
                            if not current[0].startswith(previous[0]):
                                stable_rewrites += 1
                            changes.append(dict(at_ms=elapsed, stable=current[0], tentative=current[1],
                                                queue_ms=max(0, elapsed - (offset + len(samples)) / 16)))
                            previous = current
                    final, finish_ms = request(3)
                    stopped = (time.perf_counter() - started) * 1000
                    if not changes or not final['transcript'].strip():
                        raise RuntimeError('Expected live text and a nonempty final transcript')
                    gaps = [b['at_ms'] - a['at_ms'] for a, b in zip(changes, changes[1:])]
                    if reference is None:
                        reference, offline_ms = request(5, audio)
                    reference_words = words(reference['transcript'])
                    row = dict(chunk_ms=chunk_ms, right_ms=right_ms, packet_ms=packet_ms, repeat=repeat,
                               warm_ms=warm_ms, begin_ms=begin_ms, offline_ms=offline_ms,
                               first_text_ms=changes[0]['at_ms'], text_changes=len(changes),
                               change_gap_p50_ms=statistics.median(gaps) if gaps else None,
                               change_gap_p95_ms=percentile(gaps, .95), feed_p95_ms=percentile(feeds, .95),
                               feed_total_ms=sum(feeds), max_queue_ms=max(x['queue_ms'] for x in changes),
                               stop_wait_ms=max(0, stopped - len(audio) / 16), finish_ms=finish_ms,
                               stable_rewrites=stable_rewrites, transcript=final['transcript'],
                               offline_transcript=reference['transcript'],
                               word_difference_from_offline=distance(reference_words, words(final['transcript'])),
                               offline_word_count=len(reference_words), changes=changes)
                    rows.append(row)
                    Path(options.output).write_text(json.dumps(dict(platform=platform.platform(),
                        audio=options.audio, audio_sha256=hashlib.sha256(Path(options.audio).read_bytes()).hexdigest(),
                        seconds=len(audio)/16000, binary=options.binary, configs=configs, cold_start=options.cold_start, results=rows), indent=2))
                    print(json.dumps({key: value for key, value in row.items() if key != 'changes'}), flush=True)
        finally:
            worker.stdin.close()
            try:
                worker.wait(timeout=10)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
