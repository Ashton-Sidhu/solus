# Dictation

Dictation records audio on the client and transcribes it on a host with the voice
model available. Web and mobile clients use the default host. Desktop uses its
local host when available. This behavior is the same for Claude and Codex.

Direct web connections upload a mono 16 kHz PCM16 WAV file through the authenticated
HTTP transcription route. Solus cloud connections send that WAV as base64 through
the existing `transcribeAudio` RPC on the authenticated socket. Cloud dictation does
not need an HTTP upload route or a second cloud grant for each recording. Audio
payloads are excluded from RPC debug logs.

Both routes retain the 60-minute recording limit. Cloud requests use the normal RPC
receipt handling, so a socket reconnect can recover a pending result without
starting the same transcription again. Host errors, including model readiness and
busy transcription, return to the recorder through the same result contract.

The host must support transcription and have its voice model ready. Connecting
through Solus cloud does not add a transcription engine to a standalone host.
Guest access remains subject to the existing host RPC access policy.
