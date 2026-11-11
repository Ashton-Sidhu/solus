# Dictation

Dictation records audio on the client and transcribes it on a host with the voice
model available. Web clients use the default host. Desktop uses its local host when available.
Mobile uses the iOS or Android keyboard for dictation. This behavior is the same for Claude and Codex.

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

## Custom dictionary

Profiles without a saved dictionary start with 12 editable terms: Solus,
TypeScript, JavaScript, GitHub, Node.js, Next.js, PostgreSQL, SQLite, OpenAI,
Anthropic, Claude, and Codex. The starter list includes specific aliases such as
`type script` for TypeScript. It does not replace `cloud` with Claude.
Saved dictionaries keep their values, including an empty dictionary.

Open Settings → Voice → Custom dictionary. Add a term in the field at the top.
Under Heard as, add each phrase that dictation writes instead. On mobile, select
a term to edit it. Filter the list by a term or by a phrase.

To add many terms, paste one per line. Add `=` and phrases separated by `|` to
set the phrases at the same time:

```text
Solus = soul us | sol us
TypeScript = type script
PostgreSQL = postgres
```

New terms go to the top of the list. A term that is already in the list keeps its
spelling and gains the new phrases.

Each change saves at once. The limit is 100 entries, with up to eight aliases per
entry and 80 characters per phrase. An alias cannot belong to two preferred terms.
A refused change shows its error and does not replace the saved dictionary.

The dictionary is a personal setting. It uses the existing optional settings sync.
It can be edited on desktop, web, and mobile without a transcription host. Mobile
keyboard dictation does not use these terms; iOS and Android control that service.

Each desktop or web recording takes a copy of the dictionary before opening the
microphone. Preferred terms are passed as native vocabulary hints for streaming,
batch transcription, and full-clip recovery when the model supports vocabulary.
The Parakeet Unified model supports it. HTTP uploads carry a bounded JSON prefix
with the terms; cloud RPC carries the same typed options. Empty dictionaries keep
the existing WAV upload format. A retry keeps the original recording's terms.

After transcription, one pass applies exact, case-insensitive phrase replacements
and preferred capitalization. Unicode word boundaries protect longer words.
There is no fuzzy matching or model cleanup request. Replacements affect final
text only; live partials come from the speech model. Changes to settings apply to
the next recording, for both Claude and Codex.
