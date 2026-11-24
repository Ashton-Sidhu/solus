# Solus Marketing Site

SvelteKit site for Solus public pages and docs.

## Structure

- `src/routes/+page.svelte` contains the public landing page: a statement hero with a static capture, what teams use Solus for, Solus Cloud (the network drawing in `src/lib/NetworkGraph.svelte`), connecting data, observability, automations, the Delegate/Review/Ship workflow, the FAQ, and the closing call.
- `src/routes/+layout.svelte` mounts the shared `SiteNav` and `SiteFooter` from `src/lib/` on every route. Pages do not carry their own nav or footer.
- `static/stage/seine-morning.*` is the hero stage painting: Charles-François Daubigny, *The Seine: Morning* (1874), The Metropolitan Museum of Art, Open Access (CC0), cropped to drop the mat. `src/lib/ToolMarks.svelte` draws the "works with" row from the coloured marks in `node_modules/@iconify-json/logos`.
- `src/lib/Shot.svelte` renders workspace screenshots from `static/workflow/` with their phone crops. The `orchestrate` screenshot shows a billing session beside the "Dashboard usage graph" worker's diff. The Insights and Automations screenshots were taken at 1440×900 at 2× scale. The Automations screenshot is cropped to its main pane so the template list is legible at card size. Use even pixel dimensions for each screenshot. An odd width makes the AVIF encoder produce a black image.
- The palette is the app's own light theme from `packages/workspace-ui/src/workspace.css` (container white, sidebar surface, hairline, the three inks, terracotta accent); add no colour the app does not draw. The design has no monospace type, status dots, grain, or floating rails. Buttons use the `.btn` classes and headings the `.display` class from `src/app.css`.
- `src/routes/docs/+page.svelte` contains the public product reference. Keep it in sync with app-facing behavior such as keybindings, tasks, automations, review companion, voice input, and settings.
- `src/routes/privacy` and `src/routes/terms` contain the legal pages.
- `static/robots.txt` and `static/sitemap.xml` describe the indexed public routes for `https://solus.sh`. Update both when adding or removing public pages.
- `src/routes/+layout.svelte` owns route-aware canonical, Open Graph URL, and Twitter URL metadata for indexed pages. Keep route URL metadata centralized there when adding public pages.
- `src/app.html` owns shared head defaults such as the fallback title, description, Open Graph image, Twitter image, structured data, fonts, and analytics. Keep absolute production URLs aligned with `https://solus.sh`.
- Page routes may set their own `<title>` and description in `<svelte:head>`. When a public page changes enough to update `sitemap.xml` `lastmod`, update any visible "Updated" or "Last updated" date on that page too.

## Development

Install dependencies from this directory:

```sh
bun install
```

Start the local dev server:

```sh
bun run dev
```

Build the site:

```sh
bun run build
```

Use `bun run build` as the standard compile check before handing off changes. Do not rely on a dev server for verification unless you are actively working on local visual QA.
