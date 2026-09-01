#!/usr/bin/env python3
"""Send JSON-RPC payloads to `codex app-server --listen stdio://`.

Examples:
  scripts/codex_app_server_send.py --payload '{"jsonrpc":"2.0","id":1,"method":"model/list","params":{}}'
  scripts/codex_app_server_send.py --file payload.json
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from typing import Any


DEFAULT_TIMEOUT_SECONDS = 120.0
INITIALIZE_TIMEOUT_SECONDS = 15.0


def parse_json(value: str, label: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON for {label}: {exc}") from exc


def load_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.payload is not None:
        payload = parse_json(args.payload, "--payload")
    else:
        with open(args.file, "r", encoding="utf-8") as handle:
            payload = parse_json(handle.read(), f"--file {args.file}")

    if not isinstance(payload, dict):
        raise SystemExit("Payload must be a JSON object.")
    return payload


def read_stream(stream: Any, stream_name: str, out: queue.Queue[tuple[str, str]]) -> None:
    for line in iter(stream.readline, ""):
        out.put((stream_name, line))
    out.put((f"{stream_name}:eof", ""))


def format_json(data: Any, pretty: bool) -> str:
    return json.dumps(data, indent=2, sort_keys=True)


def print_message(prefix: str, text: str, pretty: bool) -> None:
    stripped = text.strip()
    if not stripped:
        return

    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        print(f"{prefix} {stripped}")
        return

    print(f"{prefix} {format_json(parsed, pretty)}")


def send_payload(proc: subprocess.Popen[str], payload: dict[str, Any], pretty: bool) -> None:
    line = json.dumps(payload, separators=(",", ":"))
    print_message(">", line, pretty)
    assert proc.stdin is not None
    proc.stdin.write(f"{line}\n")
    proc.stdin.flush()


def wait_for_response(
    proc: subprocess.Popen[str],
    output: queue.Queue[tuple[str, str]],
    request_id: Any,
    timeout_seconds: float,
    pretty: bool,
) -> int:
    deadline = time.monotonic() + timeout_seconds
    saw_response = request_id is None
    stdout_done = False

    while time.monotonic() < deadline:
        if proc.poll() is not None and stdout_done:
            return proc.returncode or 0

        remaining = max(0.0, min(0.2, deadline - time.monotonic()))
        try:
            source, line = output.get(timeout=remaining)
        except queue.Empty:
            continue

        if source == "stdout:eof":
            stdout_done = True
            continue
        if source == "stderr:eof":
            continue

        print_message("<" if source == "stdout" else "!", line, pretty)
        if source != "stdout":
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue

        if request_id is not None and message.get("id") == request_id and ("result" in message or "error" in message):
            saw_response = True
            return 0

    if saw_response:
        return 0

    print(f"Timed out waiting for response id={request_id!r}", file=sys.stderr)
    return 124


def build_env() -> dict[str, str]:
    env = dict(os.environ)
    extras = [
        os.path.expanduser("~/.local/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    path_parts = [part for part in env.get("PATH", "").split(os.pathsep) if part]
    for entry in extras:
        if entry not in path_parts:
            path_parts.append(entry)
    env["PATH"] = os.pathsep.join(path_parts)
    env.pop("CLAUDECODE", None)
    return env


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a JSON-RPC payload to `codex app-server --listen stdio://` and print responses.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--payload", help="Full JSON-RPC payload as a JSON string.")
    source.add_argument("--file", help="Path to a file containing one JSON-RPC payload.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = load_payload(args)
    pretty = True

    proc = subprocess.Popen(
        ["codex", "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=build_env(),
    )

    assert proc.stdout is not None
    assert proc.stderr is not None
    output: queue.Queue[tuple[str, str]] = queue.Queue()
    threading.Thread(target=read_stream, args=(proc.stdout, "stdout", output), daemon=True).start()
    threading.Thread(target=read_stream, args=(proc.stderr, "stderr", output), daemon=True).start()

    try:
        initialize = {
            "jsonrpc": "2.0",
            "id": "__initialize__",
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "codex_app_server_send.py", "title": None, "version": "0.1.0"},
                "capabilities": {"experimentalApi": True, "optOutNotificationMethods": None},
            },
        }
        send_payload(proc, initialize, pretty)
        init_status = wait_for_response(
            proc,
            output,
            "__initialize__",
            INITIALIZE_TIMEOUT_SECONDS,
            pretty,
        )
        if init_status != 0:
            return init_status

        extra_roots = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "skills/extraRoots/set",
            "params": {
                "extraRoots": [("/Users/sidhu/.solus/plugins/solus/skills")],
            },
        }
        send_payload(proc, extra_roots, pretty)
        wait_for_response(
            proc,
            output,
            extra_roots.get("id"),
            DEFAULT_TIMEOUT_SECONDS,
            pretty,
        )

        send_payload(proc, payload, pretty)
        return wait_for_response(
            proc,
            output,
            payload.get("id"),
            DEFAULT_TIMEOUT_SECONDS,
            pretty,
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
