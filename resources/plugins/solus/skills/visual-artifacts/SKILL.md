---
name: visual-artifacts
description: Author and render visual, interactive local HTML artifacts flush in the Solus conversation. Use when visual or interactive output is a better medium than chat text, including charts, dashboards, annotated PR/design walkthroughs, side-by-side alternatives, simulations, visualizations, tuning controls, progress trackers, decision editors, copy-back workflows, and explicit "show/render/visualize/make" requests. This skill owns artifact product patterns, the Solus design system, sandbox constraints, and the choice between a fenced ```html block (renders live in the reply, no tool call) and the render_artifact call (a saved artifact with a work id) — always author visual HTML through it rather than hand-writing it or calling render_artifact directly. For public web images, use a markdown image link instead.
---

# Visual artifacts

Use this skill to build a VISUAL HTML deliverable that renders flush in the conversation: charts, dashboards, annotated walkthroughs, comparisons, interactive diagrams, simulations, visualizations, crisp diagrams, tuning controls, decision editors, progress trackers, and interactive widgets.

Reach for it when the result is easier to inspect, compare, tune, manipulate, or follow visually than to read as chat text. The user does not need to say "render" or "visualize" if the medium is clearly better. Use a normal chat answer when the output is short, linear, or mostly explanatory. Use a Solus work instead when the user needs a durable document, slide deck, or editable architecture/data diagram.

For public web images, keep using a markdown image link instead.

This skill does NOT produce images. Generated images arrive only from a native image-generation tool, normalized into the same artifact path and rendered by the shared artifact view — never hand-author an `<img>`-based "generated image" here.

## Workflow

1. Choose the smallest artifact pattern that makes the result useful.
2. Decide the medium (see "Fence or tool call" below): a fenced ```` ```html ```` block for something the user looks at once, `render_artifact` for something that needs a work id.
3. Author a single self-contained HTML document following the runtime contract and design philosophy below.
4. Inline the data already gathered in the session. Fetch at view time only when the value really is live.
5. Explain in chat what you built (keep explanatory prose in your response, not inside the render).
6. Deliver it. A fence goes in your reply, after the explanation, and Solus renders it in place. A tool call is your LAST step: call `render_artifact` with the finished HTML and a short `title`, and set the document `<title>` to the same text (it is the fallback name when `title` is omitted). The artifact is saved as a work under that title: it appears in the works gallery, and `update_work` revises it by the `work_id` the tool returns — never render a second copy to change one. It is not filed on the session's task unless you pass `link_to_task: true`; do that when the user asked for it on the task or the pull request, and otherwise leave it to the reader, who can link or pin it from the render's rail.

## Artifact patterns

- **Walkthrough:** annotated diffs, architecture changes, design changes, investigation timelines, or failure analysis. Put evidence and annotation side by side so the user does not reconstruct the reasoning from prose.
- **Comparison:** multiple layouts, API shapes, copy variants, implementation approaches, or tradeoffs on one canvas. Make differences obvious; avoid near-duplicates.
- **Dashboard:** metrics, grouped findings, status summaries, risk heatmaps, or run/test results from data already available in the session. Summarize large datasets rather than dumping every row.
- **Tuning control:** sliders, toggles, segmented controls, inputs, or draggable handles for values the user needs to explore, such as animation timing, thresholds, filters, priorities, or layout density.
- **Copy-back editor:** a local decision surface whose output can be pasted back into chat, such as a triage board, ordering tool, checklist, JSON builder, or prompt composer.
- **Progress tracker:** a checklist or timeline that follows work as it proceeds. Render it once with `render_artifact`, then revise it in place with `update_work` by its `work_id` — the reader keeps one tracker, not a trail of superseded copies.

## Playground explorers

A playground is the richest copy-back pattern: interactive **controls** drive a **live preview**, and a **prompt output** panel builds a natural-language instruction the user copies back into chat. The user tunes visually, then pastes the generated prompt to act on it — no need to describe a large, visual, or structural input space in words.

Reach for a playground when the input space is large, visual, or structural and hard to express as text. Six templates cover the common shapes — load the matching one from `templates/` and adapt it:

- `templates/design-playground.md` — visual design decisions (components, layout, spacing, color, type)
- `templates/data-explorer.md` — queries and structured config (SQL, APIs, pipelines, regex, cron)
- `templates/concept-map.md` — learning and relationship mapping (concept maps, scope, dependencies)
- `templates/document-critique.md` — document review with approve/reject/comment
- `templates/diff-review.md` — code diffs with line-by-line comments
- `templates/code-map.md` — codebase architecture with click-to-comment

If the request doesn't fit a template cleanly, use the closest one and adapt. Every playground still obeys the runtime contract and design philosophy below — the templates give Solus-specific structure, not an exception to them. Two panels side by side with the prompt output flowing beneath is the default shape; use normal flow (no fixed positioning, no nested scrolling) so it renders correctly as content streams in.

### State pattern

Keep a single state object. Every control writes to it; every render reads from it. One `updateAll()` re-renders the preview and rebuilds the prompt on every change — no "Apply" button.

```js
const state = { /* all configurable values */ };
const DEFAULTS = { ...state };
function updateAll() { renderPreview(); updatePrompt(); }
// every control calls updateAll() on change
```

### Prompt output

The prompt is a natural-language instruction, not a value dump. Mention only non-default choices, add qualitative language alongside numbers, and include enough context to act on without seeing the playground. Put it in a selectable readonly `<textarea>` (required by the runtime contract) with a copy button as a convenience on top.

```js
function updatePrompt() {
  const parts = [];
  if (state.radius !== DEFAULTS.radius) parts.push(`${state.radius}px corner radius`);
  if (state.shadow > 16) parts.push('a pronounced shadow');
  else if (state.shadow > 0) parts.push('a subtle shadow');
  out.value = `Update the card to use ${parts.join(', ')}.`;
}
```

### Presets

Look good on first load with sensible defaults, then offer 3–5 named presets that snap every control to a cohesive combination.

## Runtime contract (required — the artifact breaks if you ignore this)

Pass a single self-contained HTML document.

- It runs in a sandboxed frame with no origin of its own. Inline `<script>`/`<style>` are allowed, and scripts, stylesheets, images, and fonts load from any `https:` origin — pick whichever CDN you prefer. Nothing loads over plain `http:`, and relative URLs resolve against nothing, so every external reference must be an absolute https URL.
- `fetch`/XHR to any `https:` origin works. Still prefer inlining the data you already gathered in the session: a render that fetches is slower to appear, and it shows nothing at all when the reader is offline. Fetch only when the value really is live.
- The frame has no access to the workspace: no `localStorage`, no cookies, no parent DOM. State lives in the page and is gone on reload.
- It auto-sizes to its content; keep it self-contained and reasonably sized.
- Avoid fixed positioning, hidden tabs, and nested scrolling — they break when content streams in.
- Keep interactions fully client-side. Use inline scripts and deterministic page state only.
- For copy-back workflows, do not rely only on clipboard APIs from the sandbox. Provide a visible readonly `<textarea>` or selectable `<pre>` containing the final prompt, JSON, or summary. A copy button is fine as a convenience, but the selectable fallback is required.
- For controls, show immediate visual feedback and keep values visible. Prefer native controls for accessibility: buttons, sliders, checkboxes, radio groups, selects, textareas, and keyboard-reachable draggable alternatives.

## Design philosophy

The render must feel like a native part of the chat, not something embedded from elsewhere.

- **Design priority:** follow the user's prompt first, then the target product or project design system, then Solus chrome integration. When the artifact represents Solus-native data or a general assistant visualization, use Solus theme variables and the warm local palette below. When the artifact compares UI directions, mocks another product, or reviews a branded surface, match the target context enough for a fair evaluation while keeping the outer body transparent and respecting light/dark mode.
- **Surfaces:** flat. No gradients, drop shadows, or glow effects. Generous whitespace and minimal, thin (1px) borders. Keep the OUTER body transparent (no dark/colored box, no border) — Solus renders the frame chrome-less so the host chat background shows straight through.
- **Width:** the frame is as wide as the conversation. Either fill it, or cap a root card with a `max-width` and let Solus centre it (the frame centres every root block by default; do not set `margin: 0` on a capped card, or it hugs the left edge).
- **Theme:** Solus injects its OWN warm palette into the frame as CSS variables and sets the matching color-scheme for the active light/dark theme — so just use them and the artifact matches the app in both modes. Text: `--solus-text-primary` / `--solus-text-secondary` / `--solus-text-tertiary`. Accent: `--solus-accent` plus `--solus-accent-soft` / `--solus-accent-light` / `--solus-accent-border`. Warm neutrals (USE THESE for surfaces, panels, fills and hairlines — NOT grey): `--solus-art-surface` and `--solus-art-raised` (parchment/sand panels), `--solus-art-border` and `--solus-art-border-strong` (warm hairlines). Drive every text/border/fill off these; keep the body background transparent and never hardcode a hex that would vanish on the opposite theme.
- **Color:** NEVER use raw grey (no #888 / #ccc / gray-500 / rgba(0,0,0,…) neutrals) — the brand is warm parchment, so structural and "neutral" elements use the warm neutrals above (`--solus-art-border`, `--solus-text-tertiary`), not grey. For categorical / multi-series data use the brand data palette IN ORDER: `--solus-art-1` terracotta, `--solus-art-2` amber, `--solus-art-3` sage, `--solus-art-4` teal, `--solus-art-5` dusty blue, `--solus-art-6` plum (all tuned to the warm theme). For good/bad meaning use `--solus-art-positive` (green) and `--solus-art-negative`. Encode meaning, do not cycle a rainbow: same category → same colour; a single-series chart should be one colour (the accent), not many.
- **Typography:** sentence case throughout. Two weights only — regular and medium (never heavy bold). Use a clear scale for headings vs body. No font size below 11px. No emoji (use an icon font if you need glyphs). Reserve bold for headings and labels, not mid-sentence emphasis.
- **Content:** the widget stays PURELY visual — keep explanatory prose in your chat response, not inside the render. Round numbers before they hit the screen so floating-point artifacts don't leak.
- **Motion:** animate by default so the artifact feels alive. Add purposeful entrance transitions (fade/slide/scale in), let bars/lines/arcs grow or draw on load, count numbers up, and transition every interaction (hover, toggle, slider) smoothly. Use CSS transitions/keyframes or requestAnimationFrame; keep it subtle and premium (~200–600ms, ease-out, no bounce or flashing), stagger multiple elements, and honour `@media (prefers-reduced-motion: reduce)` by disabling non-essential motion.

Do not design around cloud sharing, organization permissions, public links, or hosted export. Solus artifacts are local, in-chat renders.

## Common mistakes to avoid

- Prompt output is a value dump → write it as a natural instruction with enough context to act on alone.
- Too many controls at once → group by concern; collapse advanced options.
- Preview lags behind → every control change re-renders immediately; no "Apply" button.
- Empty or broken on first load → ship sensible defaults and named presets.
- Grey or hardcoded hex → drive every colour off the Solus variables (warm neutrals, not grey; accent for single-series).
- Clipboard-only copy → always include the selectable `<textarea>`/`<pre>` fallback.
- Emoji or icon characters in output → use an icon font glyph if you need one, never an emoji.

## Fence or tool call

Solus renders a fenced ```` ```html ```` block in a reply live, in the same sandboxed frame, with no tool call at all. That is the lighter medium and it is often the right one: something visual the user reads once, glances at, and moves past.

Use `render_artifact` when the render needs an identity: you will revise it by `work_id`, it should link to a task, it belongs in the works gallery, or the user asked to keep it. Use a fence when it does not. A reader can promote a fence to an artifact themselves with "Save as artifact", so choosing the fence is never a decision that traps them.

A fence renders when its content carries a `<style>`, a `<script>`, or a whole document; a bare fragment (a lone `<div>` or `<table>`) shows as code, on the assumption that it was pasted to be read. When the content does not make that obvious, say it in the info string: ```` ```html render ```` always renders, ```` ```html source ```` always shows code.

The runtime contract and design philosophy above apply to a fence too — it is the same frame and the same palette.
