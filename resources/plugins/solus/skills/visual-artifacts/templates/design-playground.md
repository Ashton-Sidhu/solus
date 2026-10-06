# Design Playground Template

Use this template when the playground is about visual design decisions: components, layouts, spacing, color, typography, animation, responsive behavior.

## Layout

```
+-------------------+----------------------+
|                   |                      |
|  Controls         |  Live component/     |
|  grouped by:      |  layout preview      |
|  • Spacing        |  (renders in a       |
|  • Color          |   mock card or       |
|  • Typography     |   isolated surface)  |
|  • Shadow/Border  |                      |
|  • Interaction    |                      |
+-------------------+----------------------+
|  Prompt output  [ Copy ]                 |
|  selectable <textarea> beneath the panels|
+------------------------------------------+
```

Use normal flow — no fixed positioning. Keep the outer body transparent.

## Control types by decision

| Decision | Control | Example |
|---|---|---|
| Sizes, spacing, radius | Slider | border-radius 0–24px |
| On/off features | Toggle / checkbox | show border, hover effect |
| Choosing from a set | Dropdown / segmented control | font-family, easing curve |
| Colors | Pick from the Solus data palette | accent, surface tint |
| Layout structure | Clickable cards | sidebar-left / top-nav / no-nav |
| Responsive behavior | Viewport-width slider | watch grid reflow at breakpoints |

Prefer native controls (slider, checkbox, radio, select) for keyboard access. Show the live value next to each control.

## Preview rendering

Apply state values directly to a preview element's inline styles:

```js
function renderPreview() {
  const el = document.getElementById('preview');
  el.style.borderRadius = state.radius + 'px';
  el.style.padding = state.padding + 'px';
  el.style.boxShadow = state.shadow
    ? `0 ${state.shadowY}px ${state.shadowBlur}px var(--input)`
    : 'none';
}
```

Solus injects its warm palette and the active `color-scheme`, so a single preview already tracks light/dark. If the design itself needs to be checked on an opposite background, add an explicit context toggle rather than hardcoding two colour sets.

## Prompt output for design

Frame it as a direction to a developer, not a spec sheet. Mention only non-default values:

> "Update the card to feel soft and elevated: 12px border-radius, 24px horizontal padding, a medium shadow. On hover, lift it with translateY(-1px) and deepen the shadow slightly."

If the user is working in Tailwind, suggest Tailwind v4 utilities; if raw CSS, use CSS properties. Put the text in a selectable readonly `<textarea>` with a copy button above it.

## Solus styling notes

- Use the Solus theme tokens for controls and general previews. For a real product mockup, read and reproduce that product's tokens and surface treatment; scope them to the preview. Solus surfaces: `--card`, `--muted`. Hairlines: `--border`, `--input`. Text: `--foreground/secondary/tertiary`. Accent: `--primary`.
- A single-series preview uses one colour (the accent). Only reach for the data palette (`--chart-1 … --chart-3`) when swatches genuinely encode different categories.
- No raw grey, no gradients or glow, thin 1px borders, sentence case, two font weights, nothing below 11px.
- Use finite transitions when they clarify control changes; respect reduced motion. Do not restart entrance effects on each update.

## Example topics

- Button style explorer (radius, padding, weight, hover/active states)
- Card component (shadow depth, radius, content layout)
- Layout builder (sidebar width, content max-width, header height, grid)
- Typography scale (base size, ratio, line heights across h1–body–caption)
- Dashboard density (airy → compact slider that scales everything proportionally)
- Modal/dialog (width, overlay opacity, entry animation, corner radius)

## Finish

Implement the template in React and compile with `npm run bundle` as described in `SKILL.md`. Render the compiled HTML as a new work with `render_artifact`, or read and update the existing work. Use a compiled fence only for an explicitly unsaved or one-time inline result. Explain the result briefly; do not emit duplicate copies.
