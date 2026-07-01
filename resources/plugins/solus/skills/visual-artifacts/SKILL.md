---
name: visual-artifacts
description: Author and render visual, interactive local HTML artifacts flush in the Solus conversation. Use when visual or interactive output is a better medium than chat text, including charts, dashboards, annotated PR/design walkthroughs, side-by-side alternatives, simulations, visualizations, tuning controls, progress trackers, decision editors, copy-back workflows, and explicit "show/render/visualize/make an interactive" requests. This skill owns artifact product patterns, the Solus design system, sandbox constraints, and the render_artifact call. For public web images, use a markdown image link instead.
---

# Visual artifacts

Use this skill to build a VISUAL HTML deliverable that renders flush in the conversation: charts, dashboards, annotated walkthroughs, comparisons, interactive diagrams, simulations, visualizations, crisp diagrams, tuning controls, decision editors, progress trackers, and interactive widgets.

Reach for it when the result is easier to inspect, compare, tune, manipulate, or follow visually than to read as chat text. The user does not need to say "render" or "visualize" if the medium is clearly better. Use a normal chat answer when the output is short, linear, or mostly explanatory. Use a Solus work instead when the user needs a durable document, slide deck, or editable architecture/data diagram.

For public web images, keep using a markdown image link instead.

This skill does NOT produce images. Generated images arrive only from a native image-generation tool, normalized into the same artifact path and rendered by the shared artifact view — never hand-author an `<img>`-based "generated image" here.

## Workflow

1. Choose the smallest artifact pattern that makes the result useful.
2. Author a single self-contained HTML document following the runtime contract and design philosophy below.
3. Inline all data already gathered in the session. Do not fetch data at view time.
4. Explain in chat what you built (keep explanatory prose in your response, not inside the render).
5. As your LAST step, call the `render_artifact` tool with the finished HTML to render it.

## Artifact patterns

- **Walkthrough:** annotated diffs, architecture changes, design changes, investigation timelines, or failure analysis. Put evidence and annotation side by side so the user does not reconstruct the reasoning from prose.
- **Comparison:** multiple layouts, API shapes, copy variants, implementation approaches, or tradeoffs on one canvas. Make differences obvious; avoid near-duplicates.
- **Dashboard:** metrics, grouped findings, status summaries, risk heatmaps, or run/test results from data already available in the session. Summarize large datasets rather than dumping every row.
- **Tuning control:** sliders, toggles, segmented controls, inputs, or draggable handles for values the user needs to explore, such as animation timing, thresholds, filters, priorities, or layout density.
- **Copy-back editor:** a local decision surface whose output can be pasted back into chat, such as a triage board, ordering tool, checklist, JSON builder, or prompt composer.
- **Progress tracker:** a checklist or timeline updated by rendering a fresh local artifact snapshot as work proceeds. Local HTML artifacts do not have a stable update id, so make each snapshot self-contained and clearly supersede the previous one in chat.

## Runtime contract (required — the artifact breaks if you ignore this)

Pass a single self-contained HTML document.

- It runs sandboxed with a strict CSP: inline `<script>`/`<style>` are allowed; external libs must come from cdn.jsdelivr.net, unpkg.com, or cdnjs.cloudflare.com ONLY. No other origins load.
- Network access is blocked (connect-src 'none'): no fetch/XHR/websockets. Inline all data; do not call external APIs.
- It auto-sizes to its content; keep it self-contained and reasonably sized.
- Avoid fixed positioning, hidden tabs, and nested scrolling — they break when content streams in.
- Keep interactions fully client-side. Use inline scripts and deterministic page state only.
- For copy-back workflows, do not rely only on clipboard APIs from the sandbox. Provide a visible readonly `<textarea>` or selectable `<pre>` containing the final prompt, JSON, or summary. A copy button is fine as a convenience, but the selectable fallback is required.
- For controls, show immediate visual feedback and keep values visible. Prefer native controls for accessibility: buttons, sliders, checkboxes, radio groups, selects, textareas, and keyboard-reachable draggable alternatives.

## Design philosophy

The render must feel like a native part of the chat, not something embedded from elsewhere.

- **Design priority:** follow the user's prompt first, then the target product or project design system, then Solus chrome integration. When the artifact represents Solus-native data or a general assistant visualization, use Solus theme variables and the warm local palette below. When the artifact compares UI directions, mocks another product, or reviews a branded surface, match the target context enough for a fair evaluation while keeping the outer body transparent and respecting light/dark mode.
- **Surfaces:** flat. No gradients, drop shadows, or glow effects. Generous whitespace and minimal, thin (1px) borders. Keep the OUTER body transparent (no dark/colored box, no border) — Solus renders the frame chrome-less so the host chat background shows straight through.
- **Theme:** Solus injects its OWN warm palette into the frame as CSS variables and sets the matching color-scheme for the active light/dark theme — so just use them and the artifact matches the app in both modes. Text: `--solus-text-primary` / `--solus-text-secondary` / `--solus-text-tertiary`. Accent: `--solus-accent` plus `--solus-accent-soft` / `--solus-accent-light` / `--solus-accent-border`. Warm neutrals (USE THESE for surfaces, panels, fills and hairlines — NOT grey): `--solus-art-surface` and `--solus-art-raised` (parchment/sand panels), `--solus-art-border` and `--solus-art-border-strong` (warm hairlines). Drive every text/border/fill off these; keep the body background transparent and never hardcode a hex that would vanish on the opposite theme.
- **Color:** NEVER use raw grey (no #888 / #ccc / gray-500 / rgba(0,0,0,…) neutrals) — the brand is warm parchment, so structural and "neutral" elements use the warm neutrals above (`--solus-art-border`, `--solus-text-tertiary`), not grey. For categorical / multi-series data use the brand data palette IN ORDER: `--solus-art-1` terracotta, `--solus-art-2` amber, `--solus-art-3` sage, `--solus-art-4` teal, `--solus-art-5` dusty blue, `--solus-art-6` plum (all tuned to the warm theme). For good/bad meaning use `--solus-art-positive` (green) and `--solus-art-negative`. Encode meaning, do not cycle a rainbow: same category → same colour; a single-series chart should be one colour (the accent), not many.
- **Typography:** sentence case throughout. Two weights only — regular and medium (never heavy bold). Use a clear scale for headings vs body. No font size below 11px. No emoji (use an icon font if you need glyphs). Reserve bold for headings and labels, not mid-sentence emphasis.
- **Content:** the widget stays PURELY visual — keep explanatory prose in your chat response, not inside the render. Round numbers before they hit the screen so floating-point artifacts don't leak.
- **Motion:** animate by default so the artifact feels alive. Add purposeful entrance transitions (fade/slide/scale in), let bars/lines/arcs grow or draw on load, count numbers up, and transition every interaction (hover, toggle, slider) smoothly. Use CSS transitions/keyframes or requestAnimationFrame; keep it subtle and premium (~200–600ms, ease-out, no bounce or flashing), stagger multiple elements, and honour `@media (prefers-reduced-motion: reduce)` by disabling non-essential motion.

Do not design around cloud sharing, organization permissions, public links, or hosted export. Solus artifacts are local, in-chat renders.

When the HTML is ready, call `render_artifact` with it as the final step, after you have explained what you built.
