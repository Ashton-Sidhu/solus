# Solus — design foundations

**This design system ships foundations only: tokens, fonts, and a compiled
Tailwind v4 utility layer. There are no components in it.** Solus's own
component library is written in Svelte, which cannot be bundled into a React
runtime, so there is no `window.*` component global to import from — build
with plain React elements and style them with the vocabulary below.

## Setup

Link `styles.css` and nothing else — it carries the whole token layer, the
self-hosted webfonts, and every utility. No provider or theme wrapper is
needed; tokens live on `:root`.

Dark mode is **class-based**, not `prefers-color-scheme`: put `class="dark"`
on `<html>` (or any ancestor) and every semantic token flips underneath.
Because the tokens are already mode-aware, **do not write `dark:` twins for
semantic colors** — `bg-card` is correct in both modes; `dark:bg-card` is dead
weight. Reserve `dark:` for one-off cases the tokens don't cover.

Body text already inherits Inter from `html, body, #root`. Adding `font-sans`
is unnecessary but harmless — it is wired to the same variable.

## Styling idiom

Tailwind v4 utility classes over **semantic** color names. Never hardcode hex,
and avoid Tailwind's stock palette (`bg-slate-100`, `bg-blue-500`) — Solus's
neutrals are warm parchment, not grey, and a stock grey reads as a foreign
element immediately.

| Family | Names | Notes |
|---|---|---|
| Page | `background`, `foreground` | app canvas + primary text |
| Panels | `card`, `card-foreground`, `popover`, `popover-foreground` | raised surfaces |
| Brand | `primary`, `primary-foreground` | terracotta `#d97757` — the accent |
| Soft brand | `secondary`, `secondary-foreground` | tinted accent wash, **not** a neutral |
| Quiet | `muted`, `muted-foreground` | `muted` is a subtle hover wash; `muted-foreground` is secondary text |
| Hover | `accent`, `accent-foreground` | ⚠️ `accent` is the hover wash, **not** the brand color — use `primary` for brand |
| Danger | `destructive`, `destructive-foreground` | |
| Lines | `border`, `input`, `ring` | |
| Nav | `sidebar`, `sidebar-foreground`, `sidebar-border` | |
| Data | `chart-1` … `chart-5` | terracotta, amber, sage, teal, dusty blue |

Each works with `bg-`, `text-`, `border-`, `ring-`, `fill-`, `stroke-`, plus
opacity (`bg-primary/10`) and variants (`hover:bg-muted`,
`focus-visible:ring-ring`, `disabled:opacity-50`, `md:grid-cols-2`).

Radius follows `--radius: 0.5rem`; `rounded-md` / `rounded-lg` / `rounded-xl`
are the usual choices. Type is Inter (`font-sans`) with Solus's code stack on
`font-mono`. Prefer `shadow-sm`/`shadow-lg` over custom shadows.

## Where the truth lives

- `styles.css` → `tokens/foundations.css` — the compiled sheet actually applied.
- `tokens/palette.md` — every `--solus-*` primitive with its light and dark
  value, plus the table showing which primitive each semantic name resolves to.
  Read this before inventing a color.

## Idiomatic snippet

```jsx
<div className="bg-background text-foreground p-8 flex flex-col gap-6">
  <div className="bg-card border border-border rounded-xl p-5 shadow-lg">
    <h2 className="font-semibold">Session</h2>
    <p className="text-muted-foreground text-sm">Muted supporting copy.</p>
    <code className="font-mono text-xs">bun run dev</code>
  </div>
  <div className="flex gap-3">
    <button className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium">
      Run
    </button>
    <button className="border border-border rounded-lg px-4 py-2 text-sm font-medium hover:bg-muted">
      Cancel
    </button>
  </div>
</div>
```
