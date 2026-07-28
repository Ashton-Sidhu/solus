# Plan 006: Replace lightweight Tiptap editors with a canonical CodeMirror Markdown editor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 3f4ac5a..HEAD -- \
>   package.json bun.lock \
>   src/renderer/components/MarkdownEditor.svelte \
>   src/renderer/components/ui/PromptEditor.svelte \
>   src/renderer/components/editor \
>   src/renderer/components/input/InputBar.svelte \
>   src/renderer/components/pr-review \
>   src/renderer/components/settings/SettingsTabInstructions.svelte \
>   src/renderer/index.css \
>   tests/unit tests/e2e/workflows
> ```
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> behavioral mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: migration, performance, tech-debt
- **Planned at**: commit `3f4ac5a`, 2026-07-28

## Why this matters

The short-form prompt editor currently pays the cost and complexity of a rich
ProseMirror document even though its durable value is Markdown text. Ordinary
typing creates Tiptap transactions, updates a structured document, waits for a
200 ms debounce, and serializes the full document back to Markdown. Lists,
code, entities, inline references, controlled-value synchronization, and
Backspace behavior have accumulated composer-specific patches.

After this plan, every lightweight prompt and Tiptap-backed comment field will
edit one canonical Markdown string in CodeMirror. Solus references will remain
visible as inline chips, autocomplete will retain its current data sources and
keyboard behavior, and Markdown list continuation will come from CodeMirror's
official Markdown commands. The rich `DocumentEditor` and its Tiptap comment
marks remain unchanged.

The migration is intentionally string-first:

```text
canonical Markdown string
  ├── CodeMirror Markdown parsing/highlighting
  ├── Solus reference decorations (visual only)
  ├── autocomplete replacements at text offsets
  └── prompt/comment submission
```

Do not introduce a second serialized editor model. CodeMirror's `state.doc` is
the source of truth; chips are replace decorations over source ranges.

## Product decisions already made

These are requirements, not open design questions:

1. Use CodeMirror 6, not Lexical and not a raw `<textarea>`.
2. Keep literal Markdown source visible. Typing `- item` remains `- item`; do
   not hide `-` behind a rendered bullet.
3. Use CodeMirror's Markdown behavior for list and blockquote continuation.
   Because the chat input reserves plain Enter for send, bind Markdown
   continuation to Shift+Enter there.
4. Keep inline file, plan, work, PR, session, and slash-command chips.
5. Keep the exact existing serialized reference formats:
   - file: `@<path>`
   - slash command: `/<command>`
   - plan: `[title](plan://ref?<encoded metadata>)`
   - work: `[title](work://ref?<encoded metadata>)`
   - PR: `[#123 title](pr://ref?number=123)`
   - session: `[title](session://ref?<encoded metadata>)`
6. Keep current input keyboard policy:
   - autocomplete gets Enter/Tab first;
   - Enter sends with `steer`;
   - Alt+Enter sends with `queue`;
   - Shift+Enter inserts/continues Markdown;
   - ArrowUp at the start enters prompt history;
   - ArrowDown traverses forward while history is active;
   - composition Enter never submits.
7. Prompt and task-comment autocomplete remains enabled. PR/GitHub comment
   fields do not gain Solus `@file` autocomplete because `@name` means a GitHub
   user in that context.
8. Keep Tiptap for `DocumentEditor`, `DocumentPromptEditor`, rich task
   descriptions, works/docs, selection-anchored document comments, and their
   reference nodes.
9. Existing plan/document inline comment forms that already use
   `MarkdownTextarea` stay on that flat native control. They do not instantiate
   Tiptap today, and their field-level dictation is coupled to native
   `selectionStart`/`selectionEnd`; moving them adds risk without addressing
   this migration's problem.

## Current state

### Lightweight Tiptap editor

- `src/renderer/components/MarkdownEditor.svelte` — 428-line short-form Tiptap
  editor used by prompts, PR comments, review summaries, and settings.
- `src/renderer/components/ui/PromptEditor.svelte` — hosts all six autocomplete
  menus around `MarkdownEditor`.
- `src/renderer/components/editor/autocomplete.svelte.ts` — owns autocomplete
  fetching and menu state, but its editor operations still require a Tiptap
  `Editor`.
- `src/renderer/components/editor/references.ts` — Tiptap/ProseMirror cursor,
  insertion, unwrapping, and reference extraction.

`MarkdownEditor.svelte` currently serializes the whole Tiptap document after a
delay:

```ts
// src/renderer/components/MarkdownEditor.svelte:51-74
const EMIT_DEBOUNCE_MS = 200;

function emitNow() {
  if (!editorInstance) return;
  const md = getMarkdown(editorInstance);
  if (md === lastEmittedValue) return;
  lastEmittedValue = md;
  untrack(() => onValueChange(md));
}
```

It also owns custom Markdown transformations:

```ts
// src/renderer/components/MarkdownEditor.svelte:110-145
const ShiftEnter = Extension.create({ /* code/list/block splitting */ });
const BlockquoteBackspace = Extension.create({ /* lift empty blockquote */ });
```

`PromptEditor` calls a controller whose comment says it is a state machine, but
the dependencies expose a raw Tiptap editor:

```ts
// src/renderer/components/ui/PromptEditor.svelte:119-137
const ac = new AutocompleteController({
  // ...
  getEditor: ed,
  focusEditor: () => markdownEditorEl?.focus(),
  getCursorRect: () => markdownEditorEl?.getCursorRect() ?? null,
});
```

### Current prompt keyboard policy

`InputBar` owns send and history behavior:

```ts
// src/renderer/components/input/InputBar.svelte:719-746
function handleKeyDown(e: KeyboardEvent) {
  // ArrowUp/ArrowDown history handling...
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend(e.altKey ? "queue" : "steer");
  }
}
```

`PromptEditor` gives autocomplete first refusal:

```ts
// src/renderer/components/ui/PromptEditor.svelte:161-166
function handleKeyDown(e: KeyboardEvent) {
  if (ac.handleKeyDown(e)) return;
  onKeyDown?.(e);
}
```

The new editor must preserve this ordering. Add an explicit
`event.isComposing || event.keyCode === 229` guard before autocomplete or send;
the current stack relies on editor/browser composition behavior rather than
encoding this invariant itself.

### Reference source formats

The Tiptap extensions currently own serialization. Examples:

```ts
// src/renderer/components/editor/fileRefExtension.ts:59-61
renderMarkdown(node) {
  return `@${node.attrs?.path ?? ''}`
}

// src/renderer/components/editor/planRefExtension.ts:62-70
const params = new URLSearchParams({ planId, sessionId, planToolUseId, status })
return `[${safeTitle}](plan://ref?${params})`
```

Plan/work/session references are also stored in `InputState` and composed into
the final agent prompt by
`src/renderer/contexts/workspace/prompt-composer.ts`. Preserve that contract:
the migration changes editing and display, not prompt dispatch.

### Consumers

`PromptEditor` consumers will migrate automatically when its inner editor is
replaced:

- `src/renderer/components/input/InputBar.svelte`
- `src/renderer/components/automations/AutomationBuilder.svelte`
- `src/renderer/components/tasks/TaskComposer.svelte`
- `src/renderer/components/tasks/TaskDetail.svelte` — lightweight task comment
  only; rich body fields use `DocumentPromptEditor`
- `src/renderer/components/ui/prompt-composer/prompt-composer.svelte`

Direct `MarkdownEditor` consumers must be migrated explicitly:

- `src/renderer/components/pr-review/PrThreadCard.svelte`
- `src/renderer/components/pr-review/ActivityFeed.svelte`
- `src/renderer/components/pr-review/SubmitReviewModal.svelte`
- `src/renderer/components/settings/SettingsTabInstructions.svelte`

### Rich editor boundary

`src/renderer/components/editor/DocumentPromptEditor.svelte` uses
`DocumentEditor`, `referenceExtensions`, `references.ts`, and the same
`AutocompleteController`. It must keep rich Tiptap behavior. The autocomplete
refactor therefore needs two editor adapters during and after migration:

- CodeMirror adapter for `PromptEditor`
- Tiptap adapter for `DocumentPromptEditor`

Do not delete Tiptap reference extensions after deleting `MarkdownEditor`;
`DocumentPromptEditor` still imports them.

### Existing tests

- `tests/e2e/workflows/input-autocomplete.spec.ts` covers `/`, `@`, menu
  navigation, and file-chip insertion.
- `tests/e2e/workflows/input-markdown-entities.spec.ts` encodes Tiptap-specific
  rich rendering and must be replaced with canonical-source assertions.
- `tests/e2e/workflows/tab-input-state.spec.ts` covers controlled draft
  replacement across mounted tabs.
- `tests/e2e/workflows/input-focus.spec.ts` covers accessible textbox naming and
  focus-at-end.
- `tests/unit/editor-reference-transactions.test.ts` covers a
  ProseMirror-specific optimization. Keep equivalent coverage for the Tiptap
  adapter if it remains necessary; add string-token coverage for CodeMirror.
- `tests/unit/autocomplete-scope.test.ts` covers detached/tab-bound RPC routing
  and must continue to pass unchanged.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install dependencies | `bun add @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-markdown` | exit 0; `package.json` and `bun.lock` updated |
| Focused unit tests | `bun test tests/unit/reference-tokens.test.ts tests/unit/autocomplete-editor-adapter.test.ts tests/unit/plain-text-markdown-keymap.test.ts tests/unit/autocomplete-scope.test.ts tests/unit/editor-reference-transactions.test.ts` | all tests pass |
| Focused UI tests | `bun run playwright test tests/e2e/workflows/input-autocomplete.spec.ts tests/e2e/workflows/input-markdown-source.spec.ts tests/e2e/workflows/input-keyboard.spec.ts tests/e2e/workflows/tab-input-state.spec.ts tests/e2e/workflows/input-focus.spec.ts` | all tests pass |
| Required project verification | `bun run build` | exit 0, warnings only |
| Check old lightweight editor removal | `rg -n "MarkdownEditor|solus-md-editor .*ProseMirror" src/renderer tests/e2e/workflows` | no lightweight-editor matches; document-editor matches are allowed only when they do not contain `MarkdownEditor` or `.solus-md-editor` |

There is no separate repository lint or typecheck script. `bun run build` is
the required compile gate in `AGENTS.md`.

## Suggested executor toolkit

- Read the official CodeMirror Markdown API before implementing keymaps:
  <https://github.com/codemirror/lang-markdown#api-reference>. In particular,
  use `insertNewlineContinueMarkup`, `deleteMarkupBackward`, and
  `markdownKeymap`; do not recreate their list logic.
- Read the official decoration example:
  <https://codemirror.net/examples/decoration/>. Use `Decoration.replace`,
  `WidgetType`, and `EditorView.atomicRanges` for chips.
- Use `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
  `@codemirror/language`, and `@codemirror/lang-markdown` directly. Do not add
  the broad `codemirror` basic-setup bundle, which includes gutters and other
  UI that the compact composer does not need.

## Scope

### In scope

- `package.json`
- `bun.lock`
- `src/renderer/components/ui/plain-text-editor/` (new feature folder)
- `src/renderer/components/ui/comment-editor/` (new thin wrapper)
- `src/renderer/components/ui/PromptEditor.svelte`
- `src/renderer/components/editor/autocomplete.svelte.ts`
- `src/renderer/components/editor/autocomplete-editor.ts` (new)
- `src/renderer/components/editor/tiptap-autocomplete-adapter.ts` (new)
- `src/renderer/components/editor/reference-tokens.ts` (new)
- `src/renderer/components/editor/references.ts`
- `src/renderer/components/editor/DocumentPromptEditor.svelte`
- `src/renderer/components/editor/fileRefExtension.ts`
- `src/renderer/components/editor/planRefExtension.ts`
- `src/renderer/components/editor/workRefExtension.ts`
- `src/renderer/components/editor/prRefExtension.ts`
- `src/renderer/components/editor/slashRefExtension.ts`
- `src/renderer/components/editor/sessionRefExtension.ts`
- `src/renderer/components/MarkdownEditor.svelte` (delete after all consumers
  migrate)
- `src/renderer/components/input/InputBar.svelte`
- `src/renderer/components/pr-review/PrThreadCard.svelte`
- `src/renderer/components/pr-review/ActivityFeed.svelte`
- `src/renderer/components/pr-review/SubmitReviewModal.svelte`
- `src/renderer/components/settings/SettingsTabInstructions.svelte`
- `src/renderer/index.css`
- `tests/unit/reference-tokens.test.ts` (new)
- `tests/unit/autocomplete-editor-adapter.test.ts` (new)
- `tests/unit/plain-text-markdown-keymap.test.ts` (new)
- `tests/unit/editor-reference-transactions.test.ts`
- `tests/e2e/workflows/input-autocomplete.spec.ts`
- `tests/e2e/workflows/input-markdown-entities.spec.ts` (replace/rename)
- `tests/e2e/workflows/input-markdown-source.spec.ts` (new replacement)
- `tests/e2e/workflows/input-keyboard.spec.ts` (new)
- `tests/e2e/workflows/tab-input-state.spec.ts`
- `tests/e2e/workflows/input-focus.spec.ts`
- `plans/README.md` (status only)

If implementation shows that a `PromptEditor` consumer needs a one-line prop or
type adjustment to compile, that consumer may be touched only to preserve its
existing behavior. Do not redesign its surrounding UI.

### Out of scope

- `src/renderer/components/editor/DocumentEditor.svelte`
- `src/renderer/components/editor/DocumentPromptEditor.svelte` markup and rich
  editor behavior beyond constructing the new Tiptap autocomplete adapter
- `src/renderer/components/editor/referenceExtensions.ts`
- document comment marks and `src/renderer/components/plan/lib/comments.ts`
- `src/renderer/components/comments/CommentLayer.svelte`
- `src/renderer/components/plan/PlanModal.svelte`
- `src/renderer/components/plan/PlanCommentEditor.svelte`
- `src/renderer/components/ui/markdown-field/`
- dictation infrastructure in `src/renderer/lib/dictation.svelte.ts`
- assistant/user message Markdown rendering
- plan, work, slide, diagram, or document rendering
- task-description `DocumentPromptEditor` fields
- adding GitHub-user mention autocomplete to PR comments
- visually replacing Markdown syntax such as `-`, `#`, or backticks
- a preview toggle or split Markdown preview
- removing Tiptap dependencies from `package.json`; rich documents still use
  them
- rewriting autocomplete menu components or their provider/store loading
- changing serialized prompt/reference formats
- task-list-specific continuation beyond whatever the installed official
  CodeMirror Markdown command supports. If specialized `- [ ]` continuation is
  desired later, add it as a separately tested follow-up.

## Git workflow

- Branch from `main`; suggested branch: `feat/codemirror-prompt-editor`.
- Keep commits logical and reversible:
  1. characterization tests and reference primitives;
  2. CodeMirror core and decorations;
  3. autocomplete adapters and `PromptEditor` switch;
  4. direct consumer migration and old editor deletion.
- Recent history uses conventional prefixes such as
  `feat: add remote host onboarding and session dispatch`. Use
  `feat: replace prompt editor with CodeMirror`.
- Do not push or open a PR unless instructed by the operator.

## Steps

### Step 1: Characterize source, reference, and keyboard contracts

Before changing the editor, add failing-or-current characterization tests that
name the behavior being preserved.

Create `tests/unit/reference-tokens.test.ts` with golden cases for all six
reference kinds. Include:

- exact serialization strings listed in "Product decisions";
- titles containing `[` and `]`;
- URL encoding for spaces, `&`, `?`, Unicode, and Windows-like paths;
- invalid or incomplete custom URLs left as ordinary text;
- deduped plan/work/session metadata in first-occurrence order;
- file paths with a trailing `/`;
- recognized slash commands at start-of-line and after whitespace;
- ordinary email addresses and URLs not classified as file/slash chips.

Create `tests/unit/plain-text-markdown-keymap.test.ts` by constructing
CodeMirror `EditorState` values and invoking official Markdown commands. Cover:

- continuing `- item`, `* item`, `1. item`, and `> quote`;
- exiting an empty list/blockquote marker;
- Backspace removing one Markdown markup level;
- fallback newline inside fenced code;
- source text remains literal Markdown.

Update the existing E2E tests only after the new editor lands; at this stage,
record the current InputBar key contract in a new
`tests/e2e/workflows/input-keyboard.spec.ts` skeleton or test comments:

- autocomplete acceptance precedes send;
- Enter sends;
- Alt+Enter queues;
- Shift+Enter inserts/continues a line;
- composition Enter does not send;
- history navigation remains caret-sensitive.

**Verify**:

```bash
bun test tests/unit/reference-tokens.test.ts \
  tests/unit/plain-text-markdown-keymap.test.ts \
  tests/unit/autocomplete-scope.test.ts \
  tests/unit/editor-reference-transactions.test.ts
```

Expected: existing tests pass. New reference-token tests may remain pending
only until Step 2 in the same commit; do not commit a red test suite.

### Step 2: Centralize canonical reference types, parsing, and serialization

Create `src/renderer/components/editor/reference-tokens.ts`. It must contain no
Tiptap, ProseMirror, CodeMirror, Svelte, or DOM imports.

Define a discriminated union covering:

```ts
type ReferenceToken =
  | { kind: "file"; path: string; name: string }
  | { kind: "plan"; planId: string; sessionId: string; planToolUseId: string;
      title: string; status: "pending" | "accepted" | "rejected" }
  | { kind: "work"; workId: string; title: string;
      type: "doc" | "slides" | "diagram" }
  | { kind: "pr"; number: number; title: string }
  | { kind: "slash"; command: string }
  | { kind: "session"; sessionId: string; provider: AgentId;
      title: string; cwd: string };
```

Add pure functions:

- `serializeReferenceToken(token): string`
- `parseReferenceTokens(text, options): ReferenceTokenRange[]`
- `extractTrackedReferences(text): { planRefs, workRefs, sessionRefs }`
- helpers for escaping/unescaping link labels and validating custom URLs

`ReferenceTokenRange` contains zero-based CodeMirror string offsets:
`{ from, to, token }`.

Parsing requirements:

- Custom `plan://`, `work://`, `pr://`, and `session://` links are
  self-describing and must round-trip.
- A file candidate starts at start-of-line or whitespace and follows the
  existing `@` trigger grammar. Do not classify `person@example.com`.
- Slash chips are produced only for a command name supplied through parser
  options. Do not decorate arbitrary `/usr/local` text.
- Malformed metadata must not throw; return no token for that range.
- Overlapping candidates must resolve deterministically. Custom links win over
  their label contents.

Move neutral `*RefAttrs` types out of Tiptap extension modules or alias them to
the union variants. Change each extension's `renderMarkdown` and
`parseMarkdown` to call the shared pure helpers so CodeMirror and Tiptap cannot
drift.

Keep `references.ts` Tiptap-specific. It may import neutral token types and
serializers, but its ProseMirror transaction behavior remains for
`DocumentPromptEditor`.

**Verify**:

```bash
bun test tests/unit/reference-tokens.test.ts \
  tests/unit/editor-reference-transactions.test.ts
```

Expected: all tests pass, including exact golden strings matching the old
Tiptap output.

### Step 3: Build the minimal CodeMirror `PlainTextEditor`

Create the feature folder
`src/renderer/components/ui/plain-text-editor/`. Keep algorithms in colocated
`lib/*.ts`; the `.svelte` file should initialize the view, react to props,
render the wrapper, and expose thin imperative methods.

Use only the extensions needed by this product:

- `EditorState`
- `EditorView`, `keymap`, `drawSelection`, `placeholder`, line wrapping
- `history`, `historyKeymap`, and the platform/default editing keymap
- `markdown({ base: markdownLanguage, addKeymap: false,
  completeHTMLTags: false })`
- a restrained `HighlightStyle` using existing Solus theme CSS variables
- `insertNewlineContinueMarkup`, `deleteMarkupBackward`, and fallback generic
  newline/delete commands

Do not use `basicSetup`: no line numbers, gutters, folding UI, lint panel,
search panel, or CodeMirror autocomplete UI belong in the composer.

Required props:

- `value`
- `onValueChange`
- `onInput` (synchronous, cheap transaction signal)
- `onEmptyChange`
- `onKeyDown`
- `onPaste`
- `onFocus`
- `onBlur`
- `placeholder`
- `disabled`
- `maxHeight`
- `class`
- a Markdown-enter mode that supports:
  - host-reserved Enter + Markdown Shift+Enter (InputBar);
  - normal Markdown Enter (automation, tasks, comments, settings)

Required imperative handle:

- `focus(position?: "end" | number)`
- `setValueAndCursor(text, autoFocus?, cursor?: number | "end")`
- `clearEditor()`
- `isCaretAtStart()`
- `textBeforeCursor()`
- `getCursorRect()`
- the editor-neutral operations introduced in Step 5

Lifecycle requirements:

- Construct one `EditorView` per mounted component and destroy it on unmount.
- Do not recreate the view on every prop change.
- On a local edit, call `onValueChange(view.state.doc.toString())`
  synchronously. There is no Markdown serialization debounce.
- On an external `value` change, dispatch the minimal full-document change only
  when the string differs. Avoid feeding the parent's echo back into the view.
- Preserve tab-switch semantics: `setValueAndCursor` must replace even an
  identical string when the owning tab changed and place the caret as requested.
- Reconfigure `disabled` with a CodeMirror `Compartment`, not by rebuilding the
  view.
- Give the content element `role="textbox"`, `aria-multiline="true"`, and a
  stable accessible name based on the placeholder or `"Message input"`.
- Respect `event.isComposing` and legacy `keyCode === 229`.
- Keep all tabs mounted safely; the view must recover focus and measurement
  after a `display:none` → visible transition.

Styling:

- Put static wrapper Tailwind classes in Svelte markup.
- CodeMirror-generated descendants may be styled with `EditorView.theme` and
  existing CSS variables because Tailwind classes cannot be attached to those
  internal nodes.
- Match current font, line height, padding, max-height scrolling, selection,
  placeholder, and light/dark tokens.
- Do not copy the old rich heading/list/code-block card styling. Markdown
  source remains source; use syntax color/weight only.
- Preserve a stable selector such as
  `[data-testid="message-input"] .cm-content` for E2E tests.

**Verify**:

```bash
bun test tests/unit/plain-text-markdown-keymap.test.ts
bun run build
```

Expected: tests pass and the renderer builds without TypeScript/Svelte errors.

### Step 4: Render inline reference chips as atomic decorations

Add a CodeMirror extension in the plain-text editor's `lib/` folder. It reads
`parseReferenceTokens(state.doc.toString(), options)` and creates
`Decoration.replace` widgets for token ranges.

Requirements:

- Reuse the existing `.solus-token`, variant classes, icons, and labels so chip
  appearance does not regress.
- Expose the existing click callbacks for file, plan, work, and PR references.
  Preserve current behavior for session/slash tokens; do not invent a new click
  action.
- Provide `EditorView.atomicRanges` from the same range set so cursor motion
  skips a chip as a unit.
- Map existing decorations through transactions and reparse only changed
  lines/ranges plus externally replaced content. Do not synchronously parse all
  Markdown or rebuild every widget on every ordinary keystroke.
- Underlying copy/paste must be canonical source text, not only the visible chip
  label.
- Backspace/Delete behavior:
  - adjacent plan/work/PR/session/slash chips delete the whole source range in
    one transaction;
  - adjacent file chips preserve current Solus behavior: first Backspace reveals
    the existing `@path` source, places the caret at its end, and lets
    autocomplete reopen. Do not rewrite the string because it is already the
    underlying source;
  - a non-collapsed selection uses normal CodeMirror deletion;
  - Undo restores the token and its decoration in one history step.
- When a file source is revealed for editing, suppress its decoration until its
  range changes or focus/cursor leaves it. Do not store this UI-only reveal
  state outside CodeMirror.
- Widgets must be keyboard-safe, `contenteditable=false`, and must not steal
  text focus after click actions.

Add focused unit tests for range mapping, atomic deletion, file reveal, undo,
copy source, escaped titles, and an edit before/inside/after a chip.

**Verify**:

```bash
bun test tests/unit/reference-tokens.test.ts \
  tests/unit/autocomplete-editor-adapter.test.ts
```

Expected: all token and range interaction cases pass.

### Step 5: Make autocomplete editor-neutral without changing its data logic

Create `src/renderer/components/editor/autocomplete-editor.ts` with the minimum
interface the controller earns:

```ts
interface AutocompleteEditor {
  textBeforeCursor(): string;
  cursorRect(): DOMRect | null;
  focus(): void;
  replaceTrigger(pattern: RegExp, replacement: string): boolean;
  insertReference(token: ReferenceToken, pattern: RegExp): boolean;
  unwrapFileReferenceBeforeCursor(): boolean;
  extractTrackedReferences(): {
    planRefs: PlanReference[];
    workRefs: WorkReference[];
    sessionRefs: SessionReference[];
  };
}
```

The exact names may vary, but do not expose a raw Tiptap `EditorView`,
CodeMirror `EditorView`, transaction, or node through this boundary.

Refactor `AutocompleteController`:

- replace `getEditor(): Editor | null`, `focusEditor`, and `getCursorRect` with
  `getEditor(): AutocompleteEditor | null`;
- retain trigger regexes, result fetching, stale-request guards, menu indexes,
  loading state, and menu keyboard handling;
- build neutral `ReferenceToken` values in selection handlers;
- call adapter operations for replacement/insertion/ref extraction;
- preserve file drill-in and file Backspace reveal;
- preserve `onRefsChange` timing and dedupe semantics;
- do not move provider/store loading into Svelte components.

Implement:

- the CodeMirror adapter through `PlainTextEditor`'s imperative handle;
- `src/renderer/components/editor/tiptap-autocomplete-adapter.ts`, delegating to
  the existing `references.ts`, for `DocumentPromptEditor`.

Update `DocumentPromptEditor.svelte` only enough to construct the Tiptap adapter
and pass it to the controller. Its menus, extensions, rich/raw modes, comment
extensions, and public API must not change.

Add `tests/unit/autocomplete-editor-adapter.test.ts` using an in-memory string
adapter or CodeMirror `EditorState`. Cover:

- trigger replacement at start and after whitespace;
- insertion in the middle of a line;
- insertion adjacent to an existing token;
- a failed/stale expected range does not corrupt text;
- tracked-reference extraction after insert/delete;
- file reveal followed by a reopened `@` filter.

**Verify**:

```bash
bun test tests/unit/autocomplete-editor-adapter.test.ts \
  tests/unit/autocomplete-scope.test.ts \
  tests/unit/editor-reference-transactions.test.ts
bun run build
```

Expected: all tests and the build pass; `DocumentPromptEditor` still compiles
with Tiptap.

### Step 6: Switch `PromptEditor` while preserving its public contract

Replace the `MarkdownEditor` child in
`src/renderer/components/ui/PromptEditor.svelte` with `PlainTextEditor`.

Preserve the current props and exported methods so InputBar, AutomationBuilder,
TaskComposer, TaskDetail, and `PromptComposer` do not require behavioral
rewrites:

- `clearCompletions`
- `focus`
- `setValueAndCursor`
- `clearEditor`
- `isCaretAtStart`

Remove Tiptap transaction imports and use CodeMirror's synchronous update signal
to call `AutocompleteController.handleEditorChange`.

Key ordering:

1. If composing, do not run autocomplete or host send handling.
2. Let autocomplete consume Arrow keys, Enter, Tab, Escape, and file Backspace.
3. Call the host `onKeyDown`.
4. If the event is still unhandled:
   - `enterInsertsNewline=false`: plain Enter is reserved for the host;
   - `enterInsertsNewline=true`: Enter runs
     `insertNewlineContinueMarkup`, falling back to generic newline;
   - Shift+Enter in the InputBar runs the same Markdown continuation command,
     falling back to generic newline.

Update `InputBar.svelte` only where necessary to encode the explicit composition
guard and the new `setValueAndCursor` signature. Preserve Enter/Alt+Enter/history
semantics exactly.

**Verify**:

```bash
bun run playwright test \
  tests/e2e/workflows/input-autocomplete.spec.ts \
  tests/e2e/workflows/tab-input-state.spec.ts \
  tests/e2e/workflows/input-focus.spec.ts
```

Expected: all three workflows pass after selectors are updated from
`.solus-md-editor`/`.ProseMirror` to the stable CodeMirror content selector.

### Step 7: Migrate direct Tiptap comment and settings consumers

Create a thin
`src/renderer/components/ui/comment-editor/comment-editor.svelte` wrapper over
`PlainTextEditor`. It should add only comment semantics:

- multiline Markdown;
- configurable Enter policy;
- Mod+Enter submission callback;
- Escape callback where requested;
- no Solus reference autocomplete or chips by default;
- no hidden serialization/debounce.

Migrate:

- `PrThreadCard.svelte` reply editor — Mod+Enter reply, Escape cancel;
- `ActivityFeed.svelte` PR comment composer — Mod+Enter post;
- `SubmitReviewModal.svelte` summary editor — preserve modal-level Mod+Enter and
  exposed `focus()`;
- `SettingsTabInstructions.svelte` — use `PlainTextEditor` directly with normal
  Markdown Enter and blur refocus behavior.

`TaskDetail.svelte`'s lightweight task comment already uses `PromptEditor`; it
will have migrated in Step 6 and must retain its current autocomplete and
Mod+Enter behavior.

Do not migrate `CommentLayer.svelte`, `PlanModal.svelte`, or
`PlanCommentEditor.svelte`: those already use `MarkdownTextarea`, do not pay a
Tiptap cost, and retain native field dictation.

**Verify**:

```bash
rg -n "<MarkdownEditor|from [\"']\\.\\.?/.*MarkdownEditor" \
  src/renderer/components
```

Expected: the only remaining match is the component file itself, ready for
deletion.

Then run:

```bash
bun run build
```

Expected: exit 0 with warnings only.

### Step 8: Replace Tiptap-specific E2E assertions with source-first behavior

Rename `tests/e2e/workflows/input-markdown-entities.spec.ts` to
`input-markdown-source.spec.ts`. Remove assertions that expect `<code>`,
rendered headings, or rich list DOM inside the input.

Add assertions for:

- typing `` `code` rest `` leaves the exact visible/source text unchanged;
- `&lt;`, `<`, `>`, and `&` submit exactly as typed;
- fenced code does not become a structural code-block node;
- pasted multiline Markdown is byte-for-byte preserved except platform newline
  normalization already present elsewhere;
- Shift+Enter after `- item` inserts the next `- `;
- Shift+Enter on an empty list marker exits the list;
- ordinary Enter submits rather than adding a line;
- Alt+Enter preserves queue delivery;
- autocomplete Enter accepts a candidate and does not send;
- IME/composition Enter does not send;
- file chip copy yields `@path`;
- file chip Backspace reveals `@path` and reopens autocomplete;
- other chip Backspace deletes the complete canonical token;
- Undo restores chip deletion;
- external tab draft replacement works with identical strings.

Expand `input-autocomplete.spec.ts` so every currently available channel has
one insertion assertion when its fixture can be seeded. Keep existing `fixme`
tests only when the backend fixture genuinely cannot create the required
domain object; state the missing fixture in the test comment.

Add accessibility assertions:

- content has `role=textbox`, `aria-multiline=true`, and accessible name;
- chips are not separate tab stops unless they have an actual click action;
- keyboard selection can cross a chip without trapping focus.

**Verify**:

```bash
bun run playwright test \
  tests/e2e/workflows/input-autocomplete.spec.ts \
  tests/e2e/workflows/input-markdown-source.spec.ts \
  tests/e2e/workflows/input-keyboard.spec.ts \
  tests/e2e/workflows/tab-input-state.spec.ts \
  tests/e2e/workflows/input-focus.spec.ts
```

Expected: all non-`fixme` tests pass.

### Step 9: Delete the lightweight Tiptap path and obsolete CSS

Delete `src/renderer/components/MarkdownEditor.svelte`.

In `src/renderer/index.css`:

- remove `.solus-md-editor .ProseMirror` editor rules;
- remove `.solus-md-placeholder` if the new editor uses CodeMirror's placeholder;
- remove only `.solus-md-editor` branches from shared prose selectors, leaving
  `.prose-cloud` and `.solus-doc-editor` intact;
- replace the Tiptap-only `.ProseMirror-selectednode` chip selection rule with a
  CodeMirror-specific selected/adjacent state only if the new decoration
  extension needs one;
- retain shared `.solus-token` variants used by CodeMirror chips, document
  references, and rendered output links.

Do not remove Tiptap packages, reference extensions, `references.ts`, or
document styles.

Run dead-import searches:

```bash
rg -n "MarkdownEditor|solus-md-placeholder|solus-md-editor .*ProseMirror" \
  src/renderer tests
rg -n "referenceExtensions" src/renderer/components/editor
```

Expected:

- first command returns no matches;
- second command still shows `DocumentPromptEditor.svelte` and
  `referenceExtensions.ts`.

**Verify**:

```bash
bun run build
```

Expected: exit 0 with warnings only.

### Step 10: Verify typing performance and the full migration boundary

Use a production-like renderer build, not a dev server, for the final profile.
Create a temporary 20,000-character prompt containing prose, lists, fenced
code, and at least 20 reference tokens. Type 100 additional characters while
recording a Chromium performance trace.

Acceptance:

- no Tiptap/ProseMirror code appears in the prompt-input call stack;
- no Markdown-to-HTML or HTML-to-Markdown serialization runs per keystroke;
- no 200 ms delayed value flush is required before submit;
- one CodeMirror transaction corresponds to one ordinary text edit;
- reference decoration updates are limited to changed ranges/lines;
- no repeated main-thread task caused by an input transaction exceeds 50 ms on
  the development machine;
- submitted text exactly equals `view.state.doc.toString()` at the moment Enter
  is handled.

This profile is evidence, not a benchmark test with a flaky wall-clock
threshold. Record the trace summary in the PR description.

Run all focused gates:

```bash
bun test \
  tests/unit/reference-tokens.test.ts \
  tests/unit/autocomplete-editor-adapter.test.ts \
  tests/unit/plain-text-markdown-keymap.test.ts \
  tests/unit/autocomplete-scope.test.ts \
  tests/unit/editor-reference-transactions.test.ts

bun run playwright test \
  tests/e2e/workflows/input-autocomplete.spec.ts \
  tests/e2e/workflows/input-markdown-source.spec.ts \
  tests/e2e/workflows/input-keyboard.spec.ts \
  tests/e2e/workflows/tab-input-state.spec.ts \
  tests/e2e/workflows/input-focus.spec.ts

bun run build
```

Expected: all focused tests pass and the build exits 0.

## Test plan

### Unit tests

`tests/unit/reference-tokens.test.ts`

- exact source serialization for every token kind;
- safe label escaping and URL encoding;
- malformed input remains text;
- no false positives for email/URL prose;
- tracked metadata extraction and dedupe order.

`tests/unit/autocomplete-editor-adapter.test.ts`

- trigger replacement at text offsets;
- insertion around existing chips;
- file reveal;
- atomic deletion and Undo;
- decoration mapping after nearby edits;
- tracked refs after insertion/deletion.

`tests/unit/plain-text-markdown-keymap.test.ts`

- official list/blockquote continuation;
- empty-marker exit;
- markup Backspace;
- fenced-code fallback;
- literal source preservation.

Use `tests/unit/autocomplete-scope.test.ts` as the pattern for small,
intent-named Bun tests. Every test comment should explain why the behavior is a
contract rather than restating the assertion.

### E2E tests

Update the existing input workflow tests rather than creating a parallel test
harness. Keep selectors under `[data-testid="message-input"]`.

Required cases:

- autocomplete menus, selection, insertion, and dismissal;
- all send/newline/history modifier behavior;
- exact Markdown source and submission;
- chip render/click/copy/delete/reveal/undo;
- per-tab controlled drafts;
- focus restoration and accessibility;
- composition safety.

PR comment fields must receive at least a focused component or E2E regression
for Mod+Enter and Escape if the existing PR fixture can reach them reliably. If
it cannot, add a component-level test around `CommentEditor` rather than
expanding backend fixture scope.

## Done criteria

All must hold:

- [ ] `package.json` lists only the five scoped CodeMirror packages from
  "Commands you will need" as new direct dependencies, and `bun.lock` resolves
  them successfully (their transitive packages are allowed).
- [ ] `PlainTextEditor` owns one canonical `state.doc`; no HTML/Markdown
  serializer or debounce exists in its update path.
- [ ] The input displays all six reference kinds as atomic chips while copying
  and submitting their canonical source.
- [ ] Current autocomplete channels, loading behavior, placement, keyboard
  navigation, and RPC scope remain intact.
- [ ] Input Enter, Alt+Enter, Shift+Enter, history, and IME behavior matches the
  product decisions.
- [ ] Automation prompts, task prompts/comments, generic `PromptComposer`, PR
  comments/review summaries, and settings instruction fields use CodeMirror.
- [ ] `DocumentEditor`, `DocumentPromptEditor`, rich task descriptions,
  document comment marks, and rendered Markdown remain Tiptap/renderer-backed
  and behaviorally unchanged.
- [ ] Native `MarkdownTextarea` plan/document inline comments remain unchanged.
- [ ] `src/renderer/components/MarkdownEditor.svelte` is deleted.
- [ ] `rg -n "MarkdownEditor|solus-md-editor .*ProseMirror" src/renderer tests`
  returns no obsolete lightweight-editor matches.
- [ ] Focused unit tests pass.
- [ ] Focused Playwright workflows pass.
- [ ] `bun run build` exits 0.
- [ ] Performance trace meets Step 10 acceptance and is summarized in the PR.
- [ ] No unrelated source files are modified.
- [ ] The row for Plan 006 in `plans/README.md` is updated.

## STOP conditions

Stop and report back rather than improvising if:

- Any serialized reference source must change to make CodeMirror work.
- Inline chips cannot copy their underlying canonical source through supported
  CodeMirror APIs.
- `Decoration.replace` plus `atomicRanges` cannot deliver predictable
  cursor/Backspace behavior under IME or screen-reader testing.
- Preserving autocomplete requires duplicating its store/provider fetching
  logic instead of adapting only editor operations.
- `DocumentPromptEditor` would need to lose Tiptap reference nodes or rich/raw
  mode behavior.
- InputBar submission would need to read a delayed Svelte prop rather than
  CodeMirror's current document synchronously.
- Moving PR comments changes GitHub Markdown payloads or enables conflicting
  `@file` completion.
- The change requires rewriting dictation infrastructure or migrating existing
  native `MarkdownTextarea` comment fields.
- A focused verification command fails twice after a reasonable correction.
- An in-scope file has materially drifted from the current-state excerpts.

## Maintenance notes

- Treat `reference-tokens.ts` as the canonical source format contract. Any new
  reference kind must add golden parse/serialize tests before adding either a
  CodeMirror decoration or Tiptap node.
- Keep `AutocompleteController` editor-neutral. Provider/store fetching belongs
  there; cursor and insertion mechanics belong in adapters.
- Do not let `PlainTextEditor` grow into a document editor. If a requested
  feature needs tables, block drag handles, comments, or WYSIWYG structure, use
  `DocumentEditor`.
- Prefer official CodeMirror Markdown commands over local input rules.
- Review changes to keymap precedence carefully: autocomplete, IME, host send,
  Markdown continuation, and generic editing must remain in that order.
- Review decoration updates under long prompts. A future convenience should not
  reintroduce whole-document work on each keystroke.
- If specialized task-list continuation is added later, implement it as one
  narrow CodeMirror command with state-level unit tests; do not add a second
  Markdown parser or convert source into rich list nodes.
