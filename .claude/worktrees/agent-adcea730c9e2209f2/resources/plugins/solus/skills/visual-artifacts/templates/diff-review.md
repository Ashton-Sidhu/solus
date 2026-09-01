# Diff Review Template

Use this template when the playground is about reviewing code diffs: git commits, pull requests, or code changes with interactive line-by-line commenting.

## Layout

```
+-------------------+----------------------------------+
|  Commit header:   |  Diff content                    |
|  • Hash           |  (files with hunks)              |
|  • Message        |  line numbers + / − indicators   |
|  • Author/Date    |                                  |
+-------------------+----------------------------------+
|  Prompt output — all comments, formatted             |
|  [ Copy ]  — selectable <textarea>                   |
+------------------------------------------------------+
```

Use normal flow — the prompt output panel lives beneath the diff (no fixed positioning, no nested scrolling). Outer body transparent.

## Control types for diff review

| Feature | Control | Behavior |
|---|---|---|
| Line commenting | Click any diff line | Opens a textarea below the line |
| Comment indicator | Badge on commented lines | Shows which lines have feedback |
| Save/Cancel | Buttons in the comment box | Persist or discard |
| Copy prompt | Button above the output | Copies all comments (selectable fallback below) |

## Diff rendering

Parse diff data into a structured format:

```js
const diffData = [
  { file: "path/to/file.py", hunks: [
    { header: "@@ -41,13 +41,13 @@ function context", lines: [
      { type: "context",  oldNum: 41, newNum: 41, content: "unchanged line" },
      { type: "deletion", oldNum: 42, newNum: null, content: "removed line" },
      { type: "addition", oldNum: null, newNum: 42, content: "added line" },
    ]}
  ]}
];
```

## Line type styling (Solus variables)

| Type | Background | Text | Prefix |
|---|---|---|---|
| `context` | transparent | `--solus-text-primary` | ` ` (space) |
| `addition` | `--solus-art-positive` at low opacity | `--solus-art-positive` | `+` |
| `deletion` | `--solus-art-negative` at low opacity | `--solus-art-negative` | `−` |
| `hunk-header` | `--solus-art-raised` | `--solus-text-secondary` | `@@` |

Solus supplies the active `color-scheme`, so these variables already resolve correctly in light and dark — no separate hardcoded colour sets. Use `color-mix(in srgb, var(--solus-art-positive) 15%, transparent)` for the tinted row backgrounds.

## Comment system

Each diff line gets a unique id for comment tracking:

```js
const comments = {}; // { lineId: commentText }
function saveComment(lineId) {
  const text = document.getElementById(`textarea-${lineId}`).value.trim();
  if (text) comments[lineId] = text; else delete comments[lineId];
  renderDiff();        // re-render to show the indicator
  updatePromptOutput();
}
```

## Prompt output format

A structured code-review format, written into a selectable `<textarea>`:

```js
function updatePromptOutput() {
  const keys = Object.keys(comments);
  if (!keys.length) { out.value = 'Click any line to add a comment…'; return; }
  let output = 'Code review comments:\n\n';
  keys.forEach(lineId => {
    const el = document.querySelector(`[data-line-id="${lineId}"]`);
    output += `${el.dataset.file}:${el.dataset.lineNum}\n`;
    output += `   Code: ${el.dataset.content.trim()}\n`;
    output += `   Comment: ${comments[lineId]}\n\n`;
  });
  out.value = output;
}
```

Use a text label or an icon-font glyph for the location marker — never an emoji.

## Data attributes for line elements

```html
<div class="diff-line addition"
     data-line-id="0-1-5"
     data-file="src/utils/handler.py"
     data-line-num="45"
     data-content="subagent_id = tracker.register()">
```

## Pre-populating with real data

1. Run `git show <commit> --format="%H%n%s%n%an%n%ad" -p`. 2. Parse the output into the `diffData` structure. 3. Include commit metadata in the header.

## Interactive features

- Hover hint ("click to comment") on line hover.
- Comment indicator badge on lines with saved comments.
- Toast "copied" feedback on copy (plus the selectable fallback).
- Edit existing comments.

Thin borders, no raw grey, no gradients, sentence case, nothing below 11px, no emoji. Animate comment box open/close and indicator appearance; honour `prefers-reduced-motion`.

## Example topics

- Git commit review (single commit diff with line comments)
- Pull request review (multiple files, line-level comments)
- Before/after refactoring comparison
- Code audit (security findings per line)

## Finish

Explain what you built in chat, then call `render_artifact` with the finished HTML as the last step.
