# Response streaming

Settings → General → Response streaming controls delivery for the selected host.
The setting is shared by desktop, web, and mobile clients and applies to both
Claude and Codex. Changes take effect at the next response segment.

- **Streaming** (default): show completed paragraphs and fenced code blocks while
  the agent writes. The first block arrives immediately. Subsequent blocks are
  grouped within a 400 ms window, checked when the next provider chunk arrives.
- **Buffered**: retain the existing behavior: hold main-thread text until the next
  non-text event. Child-agent text retains its existing direct delivery.

The host's `ResponseTextBuffer` runs after provider normalization and before event
publication. In streaming mode it holds partial lines and open code fences. A
blank line outside a fence or a matching closing fence releases completed text.
A 24,000-character safety limit can release an incomplete block. Completion,
interruption, failure, tools, and requests for user input drain the remaining
text before the corresponding event. Usage updates do not break paragraphs.

Buffers are separate for each session and child stream. Disconnecting the last
client does not discard text. Reconnecting clients replay published blocks;
unfinished streaming text stays buffered until its normal delivery boundary.
Replay never mutates the buffer. Streaming chunks carry a `streaming` flag so
receiving a paragraph does not claim that the response has ended. The existing
RPC event transports carry this field over IPC and WebSockets.

## Rendering

The shared conversation renderer uses svelte-markdown's incremental parser and
stable token identities. Completed prefixes are reused; reference definitions
can still trigger a full parse so earlier links resolve correctly. Raw HTML
uses the full parser because adjacent HTML blocks can merge into one sandboxed
render. Fenced HTML remains eligible for incremental parsing.

Code blocks load Shiki grammars on demand. Each block retains grammar state after
completed lines and highlights only the new suffix. Line DOM nodes remain mounted
when text grows or a fence closes. Replacing the source resets the state; CRLF
input uses a full pass. Unknown languages or loading failures show escaped source.
Light and dark token colors are emitted together and switch through CSS variables.

New streaming blocks fade in once over 600 ms. Automatic bottom-follow scrolls
smoothly while the reader remains at the bottom. User input cancels that motion;
hidden views do not follow. Reduced motion disables fades and smooth following.
These changes live in shared UI, including Editor and Pill modes.

## Verification

Focused tests cover buffer boundaries, pacing, both delivery modes, interrupted
turns, provider event order, reconnect replay, syntax grammar continuation, and
scroll cancellation/reduced motion. Existing Claude and Codex control-plane
integration tests exercise their provider paths.

A disposable browser fixture uses the real Markdown and CodeBlock components:
`bun tests/fixtures/response-streaming/build.ts` after `bun run build`. When an
existing server serves `dist/client`, open `/response-fixture/index.html`.
The fixture does not load sessions or write host config. Its `responseFixture.update`
method accepts a source string and optional live flag for DOM retention checks.
