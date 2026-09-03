# 0021. Code intelligence uses SCIP indexes built on the host

## Status

Accepted

## Context

The diff pane and the file editor show code, but a name in that code was a dead
end. To learn what a function is or where it is defined, the user left Solus for
an external editor. Reviews are where this hurts most: a diff shows a call site
and hides the callee.

Two designs were possible.

1. Proxy a live language server per project through the RPC layer.
2. Build a static [SCIP](https://github.com/sourcegraph/scip) index per project
   on the host, and answer position queries from it.

Solus runs on three clients against a host that may be another machine. A
language server is a long-lived process per project with its own protocol,
lifecycle, and memory. A SCIP index is a file: one indexer run produces it, one
decoder reads it, and many languages share the format.

## Decision

Code intelligence is a **host domain** (`packages/server/src/code-intel/`) that
builds SCIP indexes with per-language tools and serves them over four RPC
methods: `codeIntelSymbolAt`, `codeIntelStatus`, `codeIntelInstall`, and
`codeIntelReindex`. One
event topic, `codeIntel.statusChanged`, tells every client when an index
starts, finishes, fails, or goes stale. The client turns each start event into
one progress toast and updates that same toast when the run finishes or fails.

- **One adapter per language.** An adapter names the marker files that detect
  the language, the tool that indexes it, the install command, and the
  invocation. TypeScript, Python, Go, and Rust ship first. Everything above the
  adapter layer is language-agnostic.
- **The index is decoded in-process without a protobuf runtime.** The SCIP
  schema is small and stable; a 300-line wire-format reader is a smaller
  dependency than protobufjs plus a vendored `.proto`. Unknown fields are
  skipped by wire type, so newer indexers stay readable.
- **The first question builds the index.** A query on a root with no index and
  an installed tool starts the build and answers "indexing". Nothing runs on a
  host until a user asks a question only an index can answer.
- **Installation is explicit and allowlisted.** A missing tool is a state, not
  an error. The Tools settings page can run the adapter's fixed installer argv
  after the user selects **Install for me**, and it keeps the manual command as
  a fallback. The RPC accepts a language enum, never a command string. Progress,
  success, and failure appear as toasts.
- **Staleness is per file, by content hash.** Every indexed document's hash is
  stored beside the index. A query on a file whose hash changed still answers,
  marked stale, and schedules one debounced rebuild. A rebuild that fails keeps
  the old index answering.
- **One cached round trip per hovered position.** `codeIntelSymbolAt` returns
  hover text, the definition, and the first reference page together. The client confirms
  that SCIP has useful symbol information or a navigation target before it
  shows the underline, then reuses that answer if the user activates the
  symbol. Words in strings, lexical misses, and empty external symbols do not
  look interactive.
- **The gesture is Cmd/Ctrl-click, or a long press on touch.** Plain clicks
  keep their existing meaning: line selection for comments in the diff, caret
  placement in the editor. A SCIP-confirmed symbol under a resting pointer
  underlines through the CSS Custom Highlight API, so no token is wrapped or
  restyled; the cursor is left alone because a plain click still does something
  else.
- **A deliberate gesture is never a dead end.** The hover underline needs a
  useful symbol, but the explicit gesture also opens the card when the index
  has a status to report: a missing tool with its install command, a build in
  progress, a failed build with a retry, or a file no indexer covers. Only a
  plain miss on a current index stays silent, so a word inside a string does
  nothing.
- **The card uses the popover's default focus behavior.** It adds no custom
  autofocus, focus-trap, arrow-key, or Enter shortcut model. Its links and
  buttons keep their native browser behavior. References are
  grouped by file with the current file first, and each line is its own target,
  so a reviewer reads "which files" before "which lines".
- **Every reference is reachable without making hover unbounded.** The first
  answer carries at most 100 reference previews. **Load more** asks
  `codeIntelReferences` for the next fixed page, so a remote client never pays
  for thousands of source lines before the user asks for them. The card
  uses the workspace's shared fixed-row virtual list for its flat file-header
  and reference-row model once it grows past 80 items. It gives that list a
  stable viewport height instead of measuring the scroll host that the list
  itself sizes.
- **Documentation clamps to four lines with a way to read the rest.** The
  affordance appears only when the clamp cuts something off, and it folds back.
  Expanded prose scrolls inside the card, so the references never leave the
  screen.
- **Only the new side of a diff navigates.** The index describes the working
  tree; a deleted line has no home in it.
- **Project locations open across from their source pane.** Go to definition
  and reference-file actions keep the diff or editor visible and open the file
  editor in the opposite pane. If the source is the only pane, the action
  creates a split. The source pane id is explicit because popover focus is not
  a reliable statement of where its code is mounted.
- **Web platform symbols are described by MDN, in the description.** When
  TypeScript identifies a DOM, Web Worker, or JavaScript standard-library symbol
  outside the project, the card names the exact MDN page when the index provides
  one, and otherwise names an MDN search instead of guessing a page.
  The summary fills the description slot, where a doc comment would have gone,
  under a `MDN · <page title>` line that says whose sentence it is and — after a
  search — which page answered. That line opens the page in the browser: the
  card answers the question in place, and the link is there for the reader who
  wants more than the opening sentence.
  A symbol with a platform reference does not also say "Defined outside this
  project." The MDN line already names the page it belongs to, so the row is
  noise. The test is the reference, not the loaded summary, so the row never
  appears for an instant and then vanishes while MDN answers.
  It is fetched only for a symbol the indexer left undescribed
  (`mdnReferenceFor`). TypeScript's DOM declarations already carry MDN's own
  sentence, so fetching a second copy would cost a round trip and say nothing
  new. A bare signature does not count as a description; it is already rendered
  above the prose.
  The host fetches and reduces the page (`code-intel/mdn-reader.ts`) and answers
  `codeIntelDocs`. It has to: a paired web client is a different origin from the
  host and a different network from the project, so the renderer cannot reach
  `developer.mozilla.org` itself. An exact page is read from its `index.json`
  lead paragraph; a search is answered from the best hit's own summary, so
  either path costs one request. Answers are cached on the host and again per
  host in the renderer store.
  A host with no route to the public internet shows no description rather than
  an error: the summary is an enrichment, and the signature, definition, and
  references stand without it.

- A symbol id is scoped to its document when SCIP made it that way. SCIP numbers
  `local N` ids per document, so the same id names a different binding in every
  file. The index therefore keys a local on its document and its id together,
  and the `symbol` the card carries back for a later reference page is that key,
  opaque to the client. Keyed on the id alone, this repo's own index put 68,079
  local occurrences into 1,540 buckets and gave one loop variable 1,584
  references across 554 unrelated files, which is both a false answer and a
  card that pages through hundreds of rows for a binding that never left its
  function.

## Consequences

- Indexes live under `SOLUS_DATA_DIR/code-intel/<root-hash>/<language>.scip`
  with a sibling `.meta.json` of file hashes. They are cache, not state, and
  can be deleted at any time.
- Svelte, Vue, and other formats without a SCIP indexer answer "no indexer
  covers this file type". Feeding `svelte2tsx` output to `scip-typescript` is a
  later project.
- Cross-language references do not link. A TypeScript client calling a Python
  endpoint resolves nothing, by design.
- Decoding a very large index blocks the host's event loop for the duration of
  the decode. If that shows up on a monorepo, the decoder moves to a worker.
- Adding a language is adding an adapter entry and a fixture-backed test.
