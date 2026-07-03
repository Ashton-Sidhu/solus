# Solus Marketing Site

SvelteKit site for Solus public pages and docs.

## Structure

- `src/routes/+page.svelte` contains the public landing page.
- `src/routes/docs/+page.svelte` contains the public product reference. Keep it in sync with app-facing behavior such as keybindings, tasks, automations, review companion, voice input, and settings.
- `src/routes/privacy` and `src/routes/terms` contain the legal pages.
- `static/robots.txt` and `static/sitemap.xml` describe the indexed public routes for `https://solus.sh`. Update both when adding or removing public pages.
- `src/app.html` owns global metadata such as canonical, Open Graph, and Twitter image URLs. Keep those URLs aligned with the production domain.

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
