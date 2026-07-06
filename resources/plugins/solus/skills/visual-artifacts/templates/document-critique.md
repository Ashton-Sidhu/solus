# Document Critique Template

Use this template when the playground helps review and critique documents: SKILL.md files, READMEs, specs, proposals, or any text that needs structured feedback with an approve/reject/comment workflow.

## Layout

```
+---------------------------+--------------------+
|  Document content         |  Suggestions panel |
|  with line numbers        |  (filterable list) |
|  and suggestion           |  • Approve         |
|  highlighting             |  • Reject          |
|                           |  • Comment         |
+---------------------------+--------------------+
|  Prompt output (approved + commented items)    |
|  [ Copy ]  — selectable <textarea>             |
+------------------------------------------------+
```

Use normal flow — no fixed positioning. Outer body transparent.

## Key components

### Document panel (left)
- Display the full document with line numbers.
- Highlight lines that have suggestions with a coloured left border.
- Colour-code by status: pending (`--solus-art-2` amber), approved (`--solus-art-positive`), rejected (`--solus-art-negative`, reduced opacity).
- Click a suggestion card to scroll to the relevant line.

### Suggestions panel (right)
- Filter tabs: All / Pending / Approved / Rejected.
- Stats in the header showing counts per status.
- Each suggestion card shows: line reference (e.g. "Line 3" or "Lines 17–24"), the suggestion text, action buttons (Approve / Reject / Comment, or Reset once decided), and an optional textarea for user comments.

### Prompt output (bottom)
- Generated only from approved suggestions and user comments.
- Grouped: Approved Improvements, Additional Feedback, Rejected (for context).
- Selectable readonly `<textarea>` with a copy button.

## State structure

```js
const suggestions = [
  {
    id: 1,
    lineRef: "Line 3",
    targetText: "description: Creates interactive...",
    suggestion: "The description is too long. Consider shortening.",
    category: "clarity",   // clarity, completeness, performance, accessibility, ux
    status: "pending",     // pending, approved, rejected
    userComment: ""
  },
];
let state = { suggestions, activeFilter: "all", activeSuggestionId: null };
```

## Suggestion matching to lines

```js
const suggestion = state.suggestions.find(s => {
  const match = s.lineRef.match(/Line[s]?\s*(\d+)/);
  if (!match) return false;
  return Math.abs(parseInt(match[1]) - lineNum) <= 2; // fuzzy-match nearby lines
});
```

## Document rendering

Handle markdown-style formatting inline — toggle a code-block wrapper on ```` ``` ```` lines, map `#`/`##` to headings, and replace inline `` `code` `` and `**bold**`. Colour code/emphasis with Solus text and accent variables.

## Prompt output generation

Only include actionable items:

```js
function updatePrompt() {
  const approved = state.suggestions.filter(s => s.status === 'approved');
  const withComments = state.suggestions.filter(s => s.userComment?.trim());
  if (!approved.length && !withComments.length) { /* placeholder */ return; }

  let prompt = 'Please update [DOCUMENT] with the following changes:\n\n';
  if (approved.length) {
    prompt += '## Approved improvements\n\n';
    for (const s of approved) {
      prompt += `**${s.lineRef}:** ${s.suggestion}`;
      if (s.userComment?.trim()) prompt += `\n  → User note: ${s.userComment.trim()}`;
      prompt += '\n\n';
    }
  }
  // Additional feedback from non-approved items with comments; rejected listed for context.
  out.value = prompt;
}
```

## Styling highlights (Solus variables)

```css
.doc-line.has-suggestion { border-left: 3px solid var(--solus-art-2); background: var(--solus-art-raised); }
.doc-line.approved       { border-left-color: var(--solus-art-positive); }
.doc-line.rejected       { border-left-color: var(--solus-art-negative); opacity: 0.6; }
```

No raw grey, no gradients, thin borders, sentence case, nothing below 11px, no emoji.

## Pre-populating suggestions

1. Read the document content. 2. Generate suggestions with specific line references, clear actionable text, and category tags. 3. Embed both the document content and the suggestions array in the HTML.

## Example use cases

- SKILL.md review (definition quality, completeness, clarity)
- README critique (missing sections, unclear explanations)
- Spec review (requirements clarity, missing edge cases, ambiguity)
- Proposal feedback (structure, argumentation, missing context)

## Finish

Explain what you built in chat, then call `render_artifact` with the finished HTML as the last step.
