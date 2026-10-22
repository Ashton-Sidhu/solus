# Solus Marketing Site

SvelteKit site for Solus public pages and docs.

## Structure

- `src/routes/+page.svelte` contains the public landing page: a statement hero with a static capture, what teams use Solus for, Solus Cloud, connecting data, sync, orchestration, the Delegate/Review/Ship workflow, the FAQ, and the closing call.
- `src/routes/demo/+page.svelte` hosts the interactive demo (`src/lib/DemoSection.svelte`), which loads the static bundle in `static/demo/`.
- `src/routes/+layout.svelte` mounts the shared `SiteNav` and `SiteFooter` from `src/lib/` on every route. Pages do not carry their own nav or footer.
- `src/lib/Shot.svelte` renders a real workspace capture from `static/workflow/` with its phone crop. The `orchestrate` capture is the demo client's billing session, whose fixture in `apps/client/src/demo/fixtures/data/sessions.json` carries the seven-worker orchestration turn. Keep every capture an even number of pixels on both sides; an odd width makes the AVIF encoder emit a file that decodes to black.
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
