# design-sync notes

## Why this is a foundations-only sync

Claude Design renders **React**: the upload format wants a `_ds_bundle.js`
exposing components on `window.<globalName>.*`, `<Name>.jsx` sources, and
`<Name>Props` type contracts. Solus is Svelte 5 end to end (373 `.svelte`
files, shadcn-**svelte**, zero React in root/`client/`/`web/`), and its
`dist/` is Electron app output, not a distributable library.

The bundled converter (`package-build.mjs` and `lib/*.mjs`) has no Svelte
support — `svelte` appears zero times across all its scripts. This is a
framework mismatch, not a heuristic one, so there is no config override that
fixes it. We therefore ship tokens/fonts/utilities and no components.

**If Solus ever publishes a React port of `ui/`, revisit** — the normal
converter path would then apply and real component cards become possible.

## How the bundle is built

Off-script. `.ds-work/entry.css` imports `src/renderer/index.css` and adds a
safelist; a small Vite build (`.ds-work/vite.config.mjs`) compiles it with
`@tailwindcss/vite`, then `.ds-work/assemble.mjs` lays out `ds-bundle/`.

Rebuild with:

```
npx vite build --config .ds-work/vite.config.mjs && node .ds-work/assemble.mjs
node .ds-work/validate.mjs   # conventions.md names must all resolve
node .ds-work/shoot.mjs      # renders light+dark, writes .ds-work/{light,dark}.png
```

## Gotchas found the hard way

- **`html, body, #root` in `index.css` sets `background: transparent
  !important`, `overflow: hidden`, `user-select: none`.** Correct for the
  Electron window; in a design canvas it silently defeats every `bg-*` on
  `<body>` and makes designs unscrollable. `assemble.mjs` strips those
  declarations and keeps the typography. It **throws** if the rule shape
  changes, so a future `index.css` refactor fails loudly rather than shipping
  a broken canvas.
- **`font-sans` / `font-mono` resolved to Tailwind's generic stacks**, not
  Solus's, so an agent writing `font-mono` got system mono. `entry.css` adds a
  small `@theme` block pointing them at `--solus-font-family` /
  `--solus-code-font-family`.
- **The safelist matters.** Tailwind only emits classes it sees, and Solus's
  own source is a narrow slice of what a design agent will write. Without
  `@source inline(...)`, utilities like `bg-background` and `ring-ring` were
  missing. Roughly 5.9k classes ship now (~905 KB).
- Semantic tokens are already mode-aware via `.dark`, so no `dark:` variants
  are safelisted for them on purpose — a `dark:bg-card` twin would be waste.
- Verifying with `grep '.bg-foo{'` gives false negatives: Tailwind merges
  selectors (`.bg-background,.bg-background\/5{...}`). Match without the brace.

## Naming trap worth keeping in the header

shadcn `primary` = the terracotta brand accent; shadcn `accent` = the subtle
hover wash, **not** the brand color. `secondary` is a tinted accent wash rather
than a neutral. Anything written against these names should say so explicitly.
