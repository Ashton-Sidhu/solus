---
name: visual-artifacts
description: Build visual HTML artifacts with one React, TypeScript, and Tailwind workflow — initialize, develop, compile to one HTML file, and render as a Solus work. Use for charts, dashboards, comparisons, simulations, design previews, and copy-back tools. Covers saved-work revisions, document embeds, sandbox constraints, and explicit Solus Cloud sharing. Use other work tools for prose, slides, and editable architecture or data diagrams; use web-building skills for deployed apps.
---

# Visual artifacts

Build a useful visual result, not a website around an answer. Start with what the user must inspect, compare, change, or copy. Use normal chat for short, linear answers.

**One authoring path: initialize React → develop → compile one HTML file → render a Solus work.** Use it for small charts and complex interactive tools alike. Complexity changes the components, not the pipeline. Sharing is an explicit action on the same work, not a second deployment.

The deliverable is a portable Solus work with a stable identity, native theme integration, version-checked revisions, reusable document embeds, and explicit access controls. The temporary React project is its build input, not a separate deployed app.

## Quick start

Resolve this skill's directory from the path used to load it. Do not assume it lives inside the user's project. Node.js 22 or later and npm are required. Scripts install only in the new artifact directory; no global installs or changes to the user's app dependencies.

### 1. Initialize

Choose a new directory outside the app source unless the user asked to keep artifact source in the project. Its parent must exist. For temporary source, create a temporary parent and give the initializer a new child path.

```sh
node "<skill-dir>/scripts/init-artifact.mjs" "<new-artifact-directory>"
```

The initializer refuses to replace an existing directory. It creates React + TypeScript source, Tailwind v4, an `@/` source alias, pinned dependencies, a lockfile through npm, a theme-aware starter, and the local bundling script. It does not launch a server or build the Solus app.

### 2. Develop

Edit `src/App.tsx`, sibling components, and `src/styles.css`. Set a meaningful title in `index.html`. Keep its mount and two artifact markers intact. Replace the example content and sample values with the requested visual and evidence.

Use React state as the source of truth for controls, preview, and copy-back output. Add only the components and dependencies the task needs. Small artifacts still use React; do not switch to a hand-authored inline JavaScript path. Native controls work well; add shadcn/Radix components only when they improve the result. Bundle added dependencies rather than loading a UI kit from a CDN.

Read [implementation guidance](references/implementation.md) for assets, data safety, state, and bundle limits. Read only a relevant playground template when the task needs it.

### 3. Compile

Run inside the artifact directory:

```sh
npm run bundle
```

This typechecks, compiles Tailwind, bundles React and browser dependencies with esbuild, inlines CSS and local assets, escapes HTML-closing sequences, and atomically writes `bundle.html`. It rejects separate chunks, external bundle dependencies, invalid shells, and payloads over 8 MiB. A failed build leaves the last successful bundle intact; do not deliver that stale file as the new result.

No development server, global package install, or application build is required. If setup fails, fix the artifact directory or report the missing prerequisite. Do not silently fall back to another authoring path.

### 4. Verify and render

Check the final payload. Do not read `bundle.html` into your output: the tools read the file on this host.

For a new visual the user asks to build, keep, revise, embed, or share, call `render_artifact` with `html_path` set to the `bundle.html` path and a short `title` matching the document title. Do not open the bundle in a browser instead; that saves no work. The returned work ID is its durable identity. Set `link_to_task: true` only when the user asked to file it on that task or its pull request. Do not also emit the same HTML in a fence.

Use the same compiled output in a rendered fence only when it is small enough to write in your reply and the result is a one-time inline explanation with no durable identity need, or the user explicitly does not want a saved work. This is a delivery option, not another build path. Use `html render artifact=<stable-name>`; names use letters, digits, hyphens, or underscores, up to 80 characters. Reuse the name for revisions of that inline visual. Emit one completed revision per identity per reply. `html source` shows code instead.

Explain the result briefly. State material limits such as sample data, network requirements, or inputs that reset on reload. Do not claim checks that were not run.

## Revise the same work

1. Use `find_works` if the work ID is unknown, then `read_work`. Read the current content and `content_version`, even if source files remain from the previous turn.
2. Reuse artifact source if it is still available, but account for changes made directly to the saved work. If source is missing, initialize a new source directory and reconstruct the requested view from the saved content and evidence. Do not pretend minified HTML is the original TSX or overwrite edits from an old source copy.
3. Develop and compile through the same pipeline.
4. Call `update_work` with the same `work_id`, `html_path` set to the new `bundle.html` path, and `expected_content_version` from the read. Do not call `render_artifact` again.
5. On a conflict, read again and reapply the change to the latest content. If edits overlap in meaning or conflicts repeat, stop and ask which change to keep.

Preserve the existing design unless redesign is requested. Source directories are build inputs, not a second work or a promised permanent archive. The saved HTML is the portable deliverable. Keep source files when the user asks for them; otherwise do not promise cross-host source availability.

To retain chosen settings, the user can copy them into chat and ask to make them new defaults. Recompile and update the same work. Saving HTML does not automatically persist page interaction state.

## Solus Cloud sharing

Keep new works private unless the user asks to share. Do not invent a URL or upload to another host.

Use the saved work's existing **Share** controls. A Local work may need explicit publication into the selected organization before it can be shared. Select the requested people or access scope; for a link intended for anyone holding it, use **Anyone with the link**, normally **Viewer** unless edit access was requested. Copy the actual returned link.

Agent work tools do not currently expose the share-link operation. If an authorized sharing tool becomes available, use its declared contract. Otherwise tell the user to open Share on the saved work, select access, and copy the link. Do not use private tokens, internal RPC calls, or database edits to bypass that boundary. Do not claim a link was created unless it was.

Sharing refers to the same work. Updates keep that identity; access changes and link regeneration can invalidate earlier links. Explain the audience before widening access. Revocation uses the same Share controls. Do not confuse Solus Cloud sharing with `publish_work`, which publishes to Google Docs or Confluence.

## Patterns and templates

- **Walkthrough:** put evidence next to annotations; separate facts from conclusions.
- **Comparison:** use the same inputs and scale; make tradeoffs visible.
- **Dashboard:** show units, denominators, source dates, and useful summaries rather than every row.
- **Simulation:** expose meaningful bounded inputs; provide pause and reset when time is part of the model.
- **Copy-back tool:** make output a complete instruction, JSON object, or summary that works without the preview.
- **Tracker:** label snapshot versus live status; update the same work instead of creating new copies.

For controls → preview → selectable output, adapt one template:
[design playground](templates/design-playground.md), [data explorer](templates/data-explorer.md), [concept map](templates/concept-map.md), [document critique](templates/document-critique.md), [diff review](templates/diff-review.md), or [code map](templates/code-map.md).
Translate template examples into React components; this file's pipeline and runtime rules take precedence.

Include reset and meaningful presets where useful. Derive preview and output from the same state; preserve focus during updates. Prompt output must be a natural instruction, not a value dump. Say when no changes are selected. Provide a visible readonly `<textarea>` or selectable `<pre>`; clipboard buttons need a failure state and are not the only way to copy.

## Sandbox contract

- One complete HTML document, no raw JSX, TypeScript, unresolved imports, local paths, or development URLs.
- The iframe has an opaque origin. No workspace DOM, files, cookies, `localStorage`, or host API. Page state resets on reload.
- Inline scripts and styles work. The build includes local assets and dependencies. Ordinary renders permit absolute HTTPS resources, but isolated review renders can block all network access.
- HTTPS fetch/XHR still needs target CORS support for an opaque origin. Prefer session data inlined at build time; live data needs loading, error, source, and refresh states. Do not disguise a snapshot as live.
- Never embed credentials or send private data to external services. Artifact creation is not permission for uploads or external writes.
- The host measures content height and supplies theme variables. Use normal flow and content-driven height, not `100vh`, fixed page shells, or custom resize loops. Stack panels in narrow containers. Use bounded overflow only for content such as wide tables.
- Local controls and copy-back text do not execute agent commands, update project files, or provide a persistence bridge. Explain incompatible requirements before building.

## Design

Follow the user's direction, then the target product's real design system, then Solus integration. Read real tokens and components before showing a product's current UI. Scope product-specific styles to the preview.

For Solus-native visuals, keep the outer body transparent, use clear spacing and thin borders, and avoid a generic marketing-page shell, gradients, glow, and heavy shadows. Product mockups can reproduce their actual surface treatment.

Use the injected palette:
- Text: `--solus-text-primary`, `--solus-text-secondary`, `--solus-text-tertiary`.
- Actions and single-series data: `--solus-accent`, `--solus-accent-soft`, `--solus-accent-light`, `--solus-accent-border`.
- Structure: `--solus-art-surface`, `--solus-art-raised`, `--solus-art-border`, `--solus-art-border-strong`.
- Categories: `--solus-art-1` through `--solus-art-6` in order. Semantic status: `--solus-art-positive` and `--solus-art-negative`.

Use `--solus-font-family` with a system fallback. Use readable sentence-case labels and regular/medium weights for native views; no text below 11px. Use inline SVG for icons and accessible names for icon-only buttons. Do not override host theme variables or force light mode. The starter provides standalone fallback colors.

Use flexible layouts, wrapping controls, and `min-width: 0`, not `screen.width`. Provide labels, visible keyboard focus, keyboard alternatives for dragging, and chart summaries or tables. Pair color with labels or shapes. Include the instructions, units, and assumptions needed to understand a saved visual.

Use finite transitions only when they clarify change; respect reduced motion. No continuous decorative animation or repeated entrance effects on input changes.

## Verification

The bundle command checks types and packaging, not visual correctness or safety of authored code. Use the smallest additional proof:
- First load, a representative control, reset, boundary values, empty selections, and invalid input.
- Copy-back output matches the preview and remains selectable without clipboard permission.
- Narrow and desktop layouts, keyboard focus, light and dark legibility.
- No fake live status, hidden runtime failures, secrets, unsupported persistence claims, or missing assets.

Use authorized browser tools when available; do not start a server without agreement. Inspect the final compiled payload, not only source. An ordinary browser preview does not prove Solus sandbox behavior. State any unverified runtime behavior. Do not create duplicate saved works for testing.

## Documents and other media

For a document containing a reusable interactive visual, render the artifact first and copy its returned embed token onto its own line in the document. Use `create_work` for a new document or slides; read and version-check updates to existing works. Revise the embedded artifact by its own work ID.

Preserve live `work://embed` links and rendered HTML fences. Use the `diagrams` skill for editable architecture, system, data-flow, or ER diagrams. Use image generation for raster images and Markdown links for public web images. Google-linked works are read-only in Solus; edit upstream and pull rather than making duplicates.
