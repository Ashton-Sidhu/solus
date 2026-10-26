# Unified prose

Status: built. Every surface uses `.prose`. The integrated visual pass is
still open (see Tests).

## Decision

Solus has one prose style for rendered and edited markdown. The transcript,
task descriptions, pull request descriptions and comments, the review guide,
and documents (works and plans) all use it. A surface sets only two things:

- `--prose-size`, the body size. Every other size is an `em` ratio of it.
- Its container: measure, padding, and the card or pane around it.

The values come from T3 Code's `chat-markdown` (`apps/web/src/index.css` in
`pingdotgg/t3code`). We keep two Solus parts: the transcript code block and the
document note band, which we use for callouts. Inline code is new.

## Why

`workspace.css` has seven prose rulesets, about 1,900 lines:

| Ruleset | Lines (approx.) | Used by |
| --- | --- | --- |
| `.prose-cloud` | 1452–1520, 2833–3020 | Base for most rendered markdown |
| `.github-markdown` | 3021–3120 | PR and task markdown (`GithubMarkdown.svelte`) |
| `.prose-reading` | 3136–3196 | Review guide, question card, assistant turns |
| `.prose-transcript`, `.prose-transcript-user` | 3198–3830 | Assistant replies, user bubbles |
| `.prose-pr`, `.task-description-prose` | 3853–4320 | PR description and activity, task description editor |
| `.solus-doc-editor .ProseMirror` | 1698–2090 | Base editor (file view, prompt editor) |
| `.doc-shell-root` | 2230–2640 | Works and plans |

Many of these rules stack on each other, so source order decides the result.
Several comments say "last in the prose region on purpose." The rulesets also
drifted apart. Tasks and PRs copied parts of T3 Code, and so did the
transcript, but each copy came out a little different:

- Body ink is primary in the transcript and documents, but secondary in tasks
  and PRs.
- h2 is 18px at weight 600 in the transcript, 15.75px at weight 500 in tasks
  and PRs, and 25px Lora at weight 500 in documents.
- Bullets are a 3px dot at 35% in the transcript, a 4px dot in tasks and PRs,
  and a native disc in documents.
- Code blocks have a hairline ring in the transcript, a filled card in tasks
  and PRs, and a left rule with a caption in documents.
- Links are terracotta in the transcript. They are blue and underlined in tasks
  and documents, and blue without an underline in PRs.
- Inline code is a chip in the transcript, tasks and PRs, plain mono in
  documents, and terracotta text in the base editor.

Mobile already has one style for all of these surfaces:
`apps/mobile/src/lib/nativeMarkdownTextStyle.ts`, adapted from T3 Code. Only
desktop and web are split.

## Vocabulary

- **Prose** — rendered or edited markdown that a person reads. It is not chrome.
- **`.prose`** — the one ruleset. Do not add a second prose ruleset.
- **Prose size** — `--prose-size`, the body size of one prose column.
- **Callout** — a GitHub alert (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`,
  `> [!WARNING]`, `> [!CAUTION]`). It is not a quote.
- **Quote** — a plain `>` blockquote. In a PR or a chat it is usually a quoted
  reply.
- **Code block** — a fenced block. **Inline code** — a backtick span.

## The style

All values are in `em` of `--prose-size`, except where a value is a hairline.

| Element | Value |
| --- | --- |
| Body | `--prose-size`, line height 1.625, ink at 80% of `--solus-text-primary`, `text-wrap: pretty` |
| Block gap | 0.65em between `p`, `ul`, `ol`, `table`, quote, and `hr`. The first child has no top margin and the last child has no bottom margin. |
| Headings | Full ink, weight 600, line height 1.3, margin 1.4em above and 0.45em below. Sizes: h1 1.4286em, h2 1.2857em, h3 1.1429em, h4–h6 1em. h6 uses tertiary ink. |
| Strong | Weight 600, full ink |
| Links | Link color, no underline. A dotted rule shows on hover and on focus. File-link chips and reference tokens keep their own treatment. |
| Inline code | The user's code face at `font-size: 1em`, x-height matched to the body (`font-size-adjust: from-font` on the root), weight 450, letter spacing −0.025em, `margin-inline: -0.04em`, full ink. No fill, no border. |
| Lists | Native markers in tertiary ink, `padding-inline-start: 1.25em`. Nested `ul` uses `circle`. `ol` markers use tabular figures. 0.25em between items. A nested list has 0.25em above it. |
| Task items | A 13px box with a hairline. A checked item has a tinted box with a tick, and its text uses tertiary ink. |
| Code block | The transcript's `.solus-code-block`: a language label and Copy in the head, a 1.5% wash over the card, a hairline ring, 10px radius. Code is 0.857em, line height 1.55. |
| Callout | The document note band: a top rule in the kind color at 40%, a bottom hairline, no fill. The label is the kind ("Note", "Tip", …) in mono, uppercase, 0.8em, in the kind color. In a wide column the label hangs in a 6.5em gutter. In a narrow column it sits above the text. |
| Quote | A 2px bar at 35% of the current color, padding 0.8em; the text keeps the prose ink, so it reads in every theme |
| Table | 0.9286em. Header row: weight 600, full ink, a 14% rule under it. Body rows: a hairline between rows, none after the last row. Cells align to the top. A table wider than its column scrolls. |
| Rule (`hr`) | A hairline, 1.4em above and below |

Callout colors use the art palette: Note `--solus-art-5`, Tip `--solus-art-3`,
Important `--solus-art-6`, Warning `--solus-art-2`, Caution
`--solus-art-negative`. Check the contrast of each label in both themes. The
light-theme amber and green may need a darker step for text.

The narrow callout layout switches on a container query, not on the window.
Use the container each surface already declares (`pane`, `doc-shell`, or a new
`prose` container on the column). The rung is 30rem, which is the same narrow
rung as `lib/pane-width.ts`.

### Prose sizes

| Surface | `--prose-size` |
| --- | --- |
| Transcript, user bubble, task and PR descriptions, PR activity, the inline diff thread card | The default, `--text-body` (14px) |
| Question card | `text-transcript-card` on the root |
| Thought | `--text-caption`; `--text-tool-step` inside a tool group |
| Review guide | `text-[length:inherit]` on the root (the review chrome rung) |
| PR comment composer | 13px (`.doc-prompt-compact`) |
| Document (works and plans) | The document font size setting, through `--solus-doc-size`. Its default is now 15px (`documentFontSize` in `packages/contracts/src/settings.ts`). Settings store only a changed value, so every user on the default moves to 15px. |

The "Interface size" setting (`--solus-font-scale`) continues to scale every
prose size except documents, which have their own size setting. The document
font family setting continues to set the face of the document column.

The current document column has a container ladder that changes the body size
at narrow widths and a phone rule that changes it back. Remove both. The
document size setting is the one size of a document, and the narrow-column
rung changes only the callout layout and the padding.

### What a surface may still add

These are not prose style, so they stay with the surface that owns them:

- Editor mechanics: the caret, the selection, the placeholder, drag handles,
  table controls, collaboration carets, and find highlights.
- Comment and annotation marks (`.plan-comment-*`, external comment
  highlights).
- The document byline under the title, and the document measure and padding.
- The user bubble's colors. The bubble sets the ink variables; it does not
  restate element rules.
- The streaming fade in the transcript.

## What goes away

- Lora on document headings. Headings use the same face as the document body.
  The "Solus preset" choice of the document font setting means the interface
  face for both. Remove `--solus-document-heading-font-family` from
  `applyDocumentFontFamily` in `settings-display.ts`. Keep the Lora import in
  `index.css`, because Lora is still a choice for the interface and document
  fonts.
- The hanging section numerals (`01`, `02`) on document h2.
- The document's "Note" label on every blockquote. The band is for callouts
  only.
- The document code block's caption row and left rule
  (`.doc-code-block__caption`). The editor's code block takes the
  `.solus-code-block` head instead. The language picker and the wrap toggle
  move into that head.
- The chip treatment of inline code on all surfaces, and the terracotta inline
  code of the base editor.
- The custom bullet drawing in `.prose-transcript` and `.prose-pr`.
- `.prose-reading`, `.prose-cloud` (prose rules), `.prose-transcript` (prose
  rules), `.prose-pr`, `.task-description-prose` (prose rules), the prose rules
  of `.solus-doc-editor .ProseMirror`, and the prose rules of `.doc-shell-root`.

## Work

### 1. Add `.prose`

`.prose` lives in `packages/workspace-ui/src/prose.css`, imported at the top of
`workspace.css`. It is in `@layer components`, so a Tailwind utility on a prose
element can still win. Unlayered prose rules beat every utility (see
`packages/workspace-ui/CLAUDE.md`).

Inline code matches the body's x-height with `font-size-adjust: from-font` on
the prose root. The browser resolves `from-font` to the root face's x-height
ratio and children inherit that number, so a code span at `1em` sets its
lowercase letters at the body's height for any body face and any code face.
No ratio is stored per font. A test in the preview browser (Chromium 148)
showed no change to emoji, Chinese, or Cyrillic fallback text.

A shared part that renders inside prose keeps its own unlayered rules, because
a layered `.prose` rule cannot override them. The code block is the main case:
its base rules (`.solus-code-block` in `workspace.css`) now carry the
transcript's values, and `--solus-code-tint` is the transcript's 1.5% wash.
Every code block looks the same, inside and outside prose.

Surfaces change only the ink, the size, or a part they do not show. These
modifiers live after the element rules in `prose.css`:

- `.prose-transcript-main` — an assistant reply; the Appearance opacity applies
  to its running text.
- `.prose-user` — the person's message bubble; the prose follows the bubble's
  colour.
- `.prose-thought` — reasoning; caption size and secondary ink.
- `.prose-question` — a question in a card; headings at body size, no images.

Bold inline code (`**`code`**`) keeps the rule at `workspace.css` near the
`strong > code` selector: it inherits the bold treatment.

### 2. Move each surface to `.prose`

Each surface moved with its old ruleset deleted in the same step.

1. **Transcript.** `TranscriptItem`, `ThoughtText`, `UserMessageBubble`,
   `HostNoticeRow`, `QuestionCard`, `SessionPreview`, `RecordTranscript`,
   `TurnTranscript`, and `TraceWaterfall`. `AssistantAlert` renders through
   `MarkdownAlert`, so a reply and a PR draw one callout.
2. **PRs and tasks.** `TaskHeader`, `CommentMarkdown`, `DiffThreadComment`,
   `ActivityFeed`, `SettingsAboutSection`, and `WorkHistoryDialog` (which had
   no prose style at all). The description measure is `max-w-[104ch]` at the
   call site. `MarkdownNode` renders a fence with `CodeBlock`, so a PR or a
   task has the one code block with its language and Copy, and wraps a table
   in a horizontal scroller. Task items, `@mentions`, and column alignment
   are in `prose.css`.
3. **Review guide.** `GuideView` and `GuideExplanation`. The weight utility
   they carried never applied under the old unlayered rules, so it was
   removed rather than let it start to apply.
4. **Editors.** `DocumentEditor` puts `.prose` on the ProseMirror root
   (`editorProps.attributes`), which covers every editor: documents, the task
   and PR descriptions, the prompt editors, and the file view. The editor
   rules in `workspace.css` keep only mechanics. `codeBlockView.ts` builds a
   `.solus-code-block` with its head; the language picker is the label, and
   wrap, render, and copy sit at the right. Focus is an accent ring.
5. **Callouts in the editor.** A `callout` node in
   `@solus/document-model/callout`, in the markdown schema, so the task and PR
   editors keep a callout too. It holds blocks, has a `kind` attribute, and
   reads and writes GitHub's form (`> [!NOTE]` then `>` lines). The editor's
   node view (`calloutView.ts`) makes the label the control: a click steps to
   the next kind. The slash menu has a Callout command.
   `DOCUMENT_SCHEMA_VERSION` is now 2, so a client and a host with different
   schemas open a live document read-only instead of deleting callouts.
   Exports that read markdown (Google Docs, Confluence) are unchanged: the
   markdown was already `> [!NOTE]`.

Dead rules found on the way and removed: `.prose-agent-card`,
`.prose-report*`, `.doc-peek`, and `.markdown-media-link-card` had no users.

### 3. Mobile

- **Inline code** is the strong ink, no fill, in Menlo at
  `fontSize × 0.526 / 0.547` (DM Sans's x-height over Menlo's), because native
  text has no `font-size-adjust`. The terracotta `--color-md-inline-code`
  token is removed, and `generated-uniwind-theme.css` is regenerated. The
  regeneration also adds the terminal tokens, which `mobileTheme.ts` already
  defined but the generated file had not caught up with.
- **Code block** size follows desktop's block (0.8125 / 0.875 of the body).
- **Callouts — mobile exception.** Enriched Markdown has no custom block, so
  the phone cannot draw the band or the kind colour. `markdownWithCallouts`
  (`lib/markdownDocument.ts`) turns the marker into the kind in bold capitals
  on its own line inside the quote, so the kind stays visible above the text,
  as in a narrow desktop column.
- **Code block head** — mobile exception. Enriched draws a fence as one block
  with no head, so the phone has no language label or Copy on a block.

### 4. Docs

No user documentation described document typography; this plan is the
record. Release notes: the "Solus preset" document font no longer uses Lora
for headings, the default document size is 15px, and documents, tasks, and
PRs gain callouts.

## Tests

- `prose-single-ruleset.test.ts` fails if a `workspace.css` rule sets the type
  of a prose element under a prose host. It proves it can see such a rule.
- `reference-token-shell.test.ts`: inline code is never a chip, and it sets at
  the body's x-height (`font-size-adjust: from-font` on the root, `1em` on the
  code).
- `document-model.test.ts`: callouts round-trip byte for byte through the host
  and the editor codecs; each kind is kept; a plain quote and a marker with
  text on its line stay quotes; a lower-case marker saves in capitals; the
  schema version names the schema with `callout: ['kind']`.
- `editor-callout.test.ts`: the label reaches every kind and wraps; an unknown
  kind reads as a note.
- `github-markdown.test.ts`: alerts render as the callout band; a fence is the
  shared code block with its language.
- `mobile-markdown-callouts.test.ts`: a callout leads with its kind; quotes,
  inline markers, and code do not change.

Still open: one integrated visual pass, with the developer's agreement — the
transcript, a task, a PR, a work, and a plan, in light and dark mode, in a
wide and a narrow pane, and the phone.

## Decisions

These were open questions. The developer answered them on 2026-10-23.

1. **The callout node in the editor is in scope.** Step 2.5 adds it.
2. **Note callouts are blue** (`--solus-art-5`), as on GitHub. Terracotta stays
   for things a user can click.
3. **Inline code in the user bubble has no fill**, the same as everywhere else.
