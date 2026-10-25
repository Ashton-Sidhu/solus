# Unified prose

Status: planned.

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
| Inline code | The mono face at `font-size: 1em`, `font-size-adjust` set to the body face's x-height ratio, weight 450, letter spacing −0.025em, `margin-inline: -0.04em`, full ink. No fill, no border. |
| Lists | Native markers in tertiary ink, `padding-inline-start: 1.25em`. Nested `ul` uses `circle`. `ol` markers use tabular figures. 0.25em between items. A nested list has 0.25em above it. |
| Task items | A 13px box with a hairline. A checked item has a tinted box with a tick, and its text uses tertiary ink. |
| Code block | The transcript's `.solus-code-block`: a language label and Copy in the head, a 1.5% wash over the card, a hairline ring, 10px radius. Code is 0.857em, line height 1.55. |
| Callout | The document note band: a top rule in the kind color at 40%, a bottom hairline, no fill. The label is the kind ("Note", "Tip", …) in mono, uppercase, 0.8em, in the kind color. In a wide column the label hangs in a 6.5em gutter. In a narrow column it sits above the text. |
| Quote | A 2px bar at 30% of the current color, padding 0.8em, tertiary ink |
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
| Transcript, user bubble, question card | `--text-body` (14px) |
| Task description, PR description, PR activity | `--text-caption` (14px) |
| Inline diff thread card | `--text-pr-prose-compact` |
| Review guide | `inherit` (the review chrome rung) |
| Document (works and plans) | The document font size setting. Its default changes from 16px to 15px (`DEFAULT_DOCUMENT_FONT_SIZE` in `contexts/app/settings-display.ts`). |

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

Add one `.prose` block to `workspace.css` with the values above. Put it in
`@layer components`, so a Tailwind utility on a prose element can still win.
Unlayered prose rules beat every utility (see
`packages/workspace-ui/CLAUDE.md`).

Inline code needs one `font-size-adjust` value for each mono face. Measure the
x-height ratio of each body face and each mono face in `APP_FONT_FAMILIES` and
`APP_CODE_FONT_FAMILIES` (`contexts/app/settings-display.ts`) once. Store the
ratio with each entry. `applyFontFamily` and the code font setter then set
`--solus-code-x-adjust` to the body face's ratio, because `font-size-adjust`
scales the mono face to that x-height. An installed font that is not a preset
has no stored ratio, so it uses the default preset's ratio. A document can have
a different face from the interface, so the document column sets its own
`--solus-code-x-adjust` from the document font.

Bold inline code (`**`code`**`) keeps the rule at `workspace.css` near the
`strong > code` selector: it inherits the bold treatment.

### 2. Move each surface to `.prose`

Change one surface at a time. Each step removes the old ruleset for that
surface in the same change.

1. **Transcript.** `TranscriptItem.svelte`, `ThoughtText.svelte`,
   `UserMessageBubble.svelte`, `HostNoticeRow.svelte`, `QuestionCard.svelte`,
   `SessionPreview.svelte`, `RecordTranscript.svelte`,
   `insights/TurnTranscript.svelte`, and `insights/TraceWaterfall.svelte`.
   `AssistantAlert.svelte` changes from a left rule with an icon to the
   callout band. `CodeSpan.svelte` drops its chip.
2. **PRs and tasks (rendered).** `GithubMarkdown.svelte`,
   `CommentMarkdown.svelte`, `MarkdownNode.svelte`, `MarkdownAlert.svelte`,
   `ActivityFeed.svelte`, `ActivityTimeline.svelte`, `PrThreadCard.svelte`,
   `PrDiffPane.svelte`, `PrReviewPane.svelte`, `DiffThreadComment.svelte`,
   `TaskActivityFeed.svelte`, `WorkHistoryDialog.svelte`, and
   `SettingsAboutSection.svelte`. Keep the GitHub-specific parts that are not
   prose style: column alignment, `@mention` weight, media link cards, and
   `<details>` rows.
3. **Review guide.** `GuideView.svelte` and `GuideExplanation.svelte`.
4. **Editors.** `DocumentEditor.svelte` puts `.prose` on the ProseMirror root.
   This covers the task description editor (`TaskHeader.svelte`), the PR
   description editor (`PrDescriptionEditor.svelte`), the prompt editor
   (`DocumentPromptEditor.svelte`), the file view
   (`MarkdownFileSurface.svelte`), and documents (`DocumentShell.svelte`).
   `codeBlockView.ts` renders the `.solus-code-block` head.
5. **Callouts in the editor.** The editor schema
   (`components/editor/lib/editor-schema.ts`) has no callout node today. Add
   one: a blockquote with a `kind` attribute that reads and writes
   `> [!KIND]` in markdown. Add a slash command for it next to the quote
   command in `slashCommands.ts`. Without this node, documents lose their note
   band, because the band no longer applies to a plain quote.

### 3. Mobile

`nativeMarkdownTextStyle.ts` already follows T3 Code. Change these to match:

- Inline code: no background, `inlineCodeColor` at full ink, the mono face.
  Check whether the Enriched Markdown renderer draws an inline background from
  `codeBackgroundColor`. If it does, give inline code its own transparent
  color.
- Callouts: check whether `PullRequestMarkdown.tsx`, `ThreadMarkdown.tsx`, and
  `FileMarkdownPreview.tsx` render GitHub alerts. Render them as the band,
  with the label above the text, because a phone is always narrow.
- Code block: a language label and a copy action, if the renderer allows a
  head. If it does not, record this as a mobile exception in this plan.

### 4. Docs

- Update `docs/` where it describes document typography (Lora, numerals).
- Record in the release notes that the "Solus preset" document font no longer
  uses Lora for headings, and that the default document size is now 15px.

## Tests

- A unit test that parses `workspace.css` and fails if a selector outside
  `.prose` sets `font-size`, `line-height`, `margin`, or `color` on a prose
  element (`p`, `h1`–`h6`, `li`, `code`, `pre`, `blockquote`, `table`) under a
  prose surface class. This keeps a second ruleset from coming back.
- The editor callout node: markdown with each `> [!KIND]` loads as a callout
  with that kind and saves back to the same markdown. A plain `>` quote stays a
  quote.
- `AssistantAlert` and `MarkdownAlert` render the same band markup for the same
  kind.
- `bun run lint:layout` passes. The callout layout uses a container query.

Visual verification needs one integrated pass after all surfaces move, with
the developer's agreement: the transcript, a task, a PR, a work, and a plan, in
light and dark mode, in a wide pane and in a narrow pane.

## Open questions

1. **The callout node in the editor.** Step 2.5 adds a node to the editor
   schema. It is the only part of this plan that changes saved data. Is it in
   scope, or does a document show callouts only when it renders markdown that
   already has them?
2. **Accent for Note.** The old document band used terracotta for every note.
   This plan uses blue for Note, as GitHub does. Terracotta then stays for
   things a user can click.
3. **User bubble.** The bubble sets its own ink. Confirm that inline code in
   the bubble also has no fill. On a filled bubble, mono text alone may be hard
   to see.
