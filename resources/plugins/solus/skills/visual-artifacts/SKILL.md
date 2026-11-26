---
name: visual-artifacts
description: Read before any chart, diagram, table, comparison, or other visual in a reply or a saved work. Holds the design rules of a Solus render (theme tokens, colour meaning, layout, diagrams, charts), how to check it, and the React, TypeScript, and Tailwind path for an interactive tool or a saved work with state. Covers revisions, document embeds, sandbox limits, and sharing. For an app that lives in Solus (a tool, a tracker, a browser for the user's data, or something that runs on a schedule or a webhook), use the create-app skill. Use other work tools for prose and slides; use web-building skills only for a codebase to deploy.
---

# Visual artifacts

Build a useful visual result, not a website around an answer. Start with what the user must inspect, compare, change, or copy. Use normal chat for short, linear answers.

**An app is not an artifact.** When the user asks for something they keep and use, such as a tracker, a tool, a browser for their data, or a job that runs on a schedule or a webhook, load the create-app skill and build an app. It is a program on the host with a backend, its own data, and a UI in its own window, and it starts from that skill's starter app. The rules of this file do not apply to it.

## Choose the path

- **Inline HTML** is the default for a visual in a reply: a chart, a diagram, a table, a comparison, a mock-up. Write one self-contained page with an inline `<style>` and, when it needs one, an inline `<script>`. No project, no npm.
- **React** is for an interactive tool or a saved work with several controls and state, or one that needs a library from npm. Follow "React path" below.

Both paths end the same way: check the page with `render_artifact` and `preview: true`, then show it in a fence or save it as a work ("Show and save").

A visual that you add without a request gets the same care as one the user asked for. A quick diagram that is wrong or hard to read is worse than none.

## Design

An artifact matches the theme of Solus, so that it reads as a part of the conversation or the document it is in. An app is different: the create-app skill has its rules.

Follow the user's direction, then the target product's real design system, then Solus integration. Read real tokens and components before showing a product's current UI. Scope product-specific styles to the preview. For Solus-native visuals, keep the outer body transparent, use clear spacing and thin borders, and avoid a marketing-page shell, gradients, glow, and heavy shadows.

### Tokens and what each one means

The frame supplies these tokens. They follow the user's light or dark mode live. Never use fixed colours, never override a token, and never force light mode.

- Page and text: `--background` (the conversation around the frame), `--foreground` for body text and titles, `--muted-foreground` for descriptions and secondary text.
- Surfaces: `--card` is the page itself, so a card shows by its border. `--muted`, `--secondary`, and `--code-background` are one neutral wash: chips, code, table heads, and the hover fill. `--popover` is for menus.
- Lines: `--border` for hairlines and card edges, `--input` for field edges and stronger lines.
- Selection: `--accent-surface` is the selected or current fill, a tint of the day blue of `--chart-1`. Hover is `--muted`, so a hovered row never looks selected.
- Actions: `--primary` and `--primary-foreground` for solid buttons, `--accent` for the brand accent, `--ring` for focus. In a mock-up of a Solus screen, use `--brand` and `--brand-foreground` for solid buttons.
- Status: `--destructive`, `--warning`, `--success`, `--info`, each with a `-foreground` for coloured text; `--destructive-surface` and `--warning-surface` for tinted boxes. Mark a warning or an error box with a 3px bar and an icon in its colour, and keep its title in body text: a tint alone reads as a plain box.
- Categories: `--chart-1` to `--chart-6` (day blue, teal, dawn gold, night violet, dusk rose, terracotta). Use them for chart series, diagram zones, and legends, in that order. Tint a fill with `color-mix(in oklab, var(--chart-N) 8%, transparent)` and draw its edge at about 45%.
- Shape and type: `--radius`, `--font-sans`, `--font-mono`.

Hue carries meaning: blue is selection, amber is a warning, red is an error, and a chart colour is a category. Keep everything else neutral, so that the meaning stays clear.

### Type

The base stylesheet sets a 14px font. Use sentence-case labels and regular or medium weights; no text below 11px. A chart colour is too light for small text, so write labels in `--foreground` or `--muted-foreground`; a zone label can use its colour only at 11px semibold or larger. Use inline SVG for icons and give icon-only buttons an accessible name.

### Layout

The frame is the page: it is as wide as the conversation, the side pane, or the share view, often 736 to 1088px. Lay out to the full width; do not put the root in a fixed or maximum-width column. Limit only two things:
- the line length of prose, for example `max-width: 70ch` on a paragraph
- an SVG diagram: give it a `max-width` equal to its `viewBox` width. An SVG with `width: 100%` scales its text with the frame, so in a wide column its text grows far larger than the page text.

The frame is borderless and aligned with the text around it: give `html`, `body`, and the outermost element no background colour (this overrides a style preference for a page background), no horizontal padding, and no outer card, border, or banner title.

A box with its own background gets at least 16px padding and `var(--radius)` corners. Use flexible layouts, wrapping controls, and `min-width: 0`, not `screen.width`. Stack panels in a narrow frame. Provide labels, visible keyboard focus, and keyboard alternatives for dragging. Pair colour with labels or shapes.

### Diagrams

Show the real mechanism with real names: the components, the domains, the stores. Abstract slots make a weak diagram.
- Draw each trust boundary or layer as a zone: a tint of one chart colour with white cards (`--card`) inside it.
- Draw connectors in inline SVG with arrow markers. Do not use text arrows between boxes.
- Number each connection with a small filled circle, and explain each number in a list under the diagram.
- Route lines so that they do not cross where you can avoid it, and keep each number on its line.

### Charts

Give a chart a fixed pixel height. Show the details of a data point on hover: the series, the exact value with units, and the date or category. Show the same details on keyboard focus and touch selection. Do not rely on the browser's native tooltip. Keep the details inside the frame, and keep a summary or a data table.

### Motion

Use finite transitions only when they make a change clear, and respect reduced motion. No continuous decoration and no entrance effects on each input change.

## Check

Check each page with `render_artifact` and `preview: true` before you show it:
- at the default width (736px, the narrowest usual column) and at `preview_width: 1088` for a wide layout
- in `light` and `dark` with `preview_appearance`
- in the console output: no errors and no missing images

After every change, preview again. Do not show a page that you changed after its last preview. Also check what applies: a representative control, reset, empty and boundary values, keyboard focus, chart details on hover, focus and touch, and values that match the data. Do not claim checks that you did not run. Do not create duplicate saved works for testing.

## Show and save

- **A fence** for a visual the user reads once: write the checked page in a ` ```html render artifact=<stable-name>` fence. Reuse the name to revise that visual, and emit one completed revision per name in a reply.
- **A saved work** for a visual the user will keep, revise, embed, or share: call `render_artifact` without `preview`. Its work ID is its identity. Do not also put the same HTML in a fence.

The reader sees the page as part of your reply: do not announce it or restate it. Explain the result briefly, and state limits such as sample data or inputs that reset on reload.

**Revise a saved work:** read it with `read_work` (use `list_works` if the ID is unknown) for its current content and `content_version`. Change it, then call `update_work` with the same `work_id` and that `expected_content_version`. On a conflict, read it again and apply the change to the latest content; if edits overlap in meaning, ask which to keep. Keep the existing design unless the user asks for a new one.

**Documents:** to put an interactive visual in a document, save the artifact first and put its embed token on its own line in the document. Keep live `work://embed` links and rendered fences in a document. Use image generation for raster images. Google-linked works are read-only in Solus.

**Sharing:** keep new works private unless the user asks to share. Agent tools cannot make a share link: tell the user to open **Share** on the saved work, choose the access, and copy the link. Do not invent a URL, and do not confuse sharing with `publish_work`, which publishes to Google Docs or Confluence.

## React path

Resolve this skill's directory from the path used to load it. Node.js 22 or later and npm are required. Scripts install only in the new artifact directory.

1. **Initialize** in a new directory outside the app source, unless the user asked to keep the source in the project. The initializer refuses to replace a directory. It creates React, TypeScript, Tailwind v4, pinned dependencies, a theme-aware starter, and the bundling script.

   ```sh
   node "<skill-dir>/scripts/init-artifact.mjs" "<new-artifact-directory>"
   ```

2. **Develop** in `src/App.tsx`, sibling components, and `src/styles.css`. Set a meaningful title in `index.html`, and keep its mount and two artifact markers. Use React state as the one source for controls, preview, and copy-back output. Add only the dependencies the task needs, and bundle them; do not load a UI kit from a CDN. Read [implementation guidance](references/implementation.md) for assets, data safety, state, and bundle limits.
3. **Compile** inside the artifact directory with `npm run bundle`. It typechecks, compiles Tailwind, bundles with esbuild, inlines CSS and local assets, and writes `bundle.html`. It rejects separate chunks, external dependencies, and payloads over 8 MiB. A failed build keeps the last good bundle: do not deliver that stale file.
4. **Check and show** the bundle with `render_artifact` and `html_path` set to `bundle.html`. Do not read the bundle into your output. To revise, compile again and call `update_work` with the new `bundle.html`.

For a tool of controls, a preview, and selectable output, adapt one template: [design playground](templates/design-playground.md), [data explorer](templates/data-explorer.md), [concept map](templates/concept-map.md), [document critique](templates/document-critique.md), [diff review](templates/diff-review.md), or [code map](templates/code-map.md). Include reset and useful presets. Derive the preview and the output from the same state. Copy-back output must be a complete instruction or object, in a visible read-only `<textarea>` or selectable `<pre>`; a clipboard button needs a failure state.

Source directories are build inputs. The saved HTML is the deliverable; do not promise that the source stays available.

## Sandbox contract

- One complete HTML document: no raw JSX, TypeScript, unresolved imports, local paths, or development URLs.
- The frame has an opaque origin: no workspace DOM, files, cookies, `localStorage`, or host API. Page state resets on reload. An app's UI is the one exception (the create-app skill).
- Inline scripts and styles work. Ordinary renders can load absolute HTTPS resources, but isolated review renders can block all network access. A fetch needs CORS support for an opaque origin. Prefer data inlined at build time; live data needs loading, error, source, and refresh states. Do not show a snapshot as live.
- Never embed credentials or send private data to external services.
- The host measures the content height. Use normal flow, not `100vh`, fixed page shells, or resize loops. Use bounded overflow only for wide content such as a table.
- Controls and copy-back text cannot run agent commands, change project files, or save state. When the user needs persistence, files, a database, or live data, build an app.
