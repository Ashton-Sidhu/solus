# Design a product

An artifact in a reply matches the theme of Solus. An app does not have to: you have creative liberty with its layout, its palette, its type, and its components. An app is a product that the user opens every day. Design it to the standard of an application that a good product team ships. A column of inputs under a toolbar is a form over a database, and it is not an acceptable result. Decide the design before you write components.

The starter's look is a sample for Notes, not a house style. Keep its patterns and replace its look. An app that keeps the starter's page color, accent, wordmark, and single column is not finished, unless the brief chose them for a reason that it states.

## Write the brief

Before you write a component, write a brief of about five lines, and keep it in your reply to the user:

- **Tone.** One word for how the app feels: calm, dense, playful, clinical, editorial, technical.
- **Accent.** One color that comes from the subject, and why. A finance tool, a garden log, and an incident board do not share a color.
- **Face.** The display face and the body face. The system face is a choice, not a default.
- **Shell.** A sidebar, a top bar with tabs, a split view, a board, or a single page, and why this subject needs it.
- **Signature.** One detail that belongs to this app only: a chart in the header, a status strip, a card shape, a way to show time.

Then build from the brief, and check each preview against it.

## The parts

- **Identity.** Give the app a wordmark and an icon in its navigation, and the accent from the brief. Define your own colors for both modes with `light-dark()`, in the same form as the starter's `@theme` block (its values are Notes' own; do not keep them). The page's `color-scheme` follows the theme of Solus, so do not use Tailwind's `dark:` variant or a media query for them. For example, a recipe app:
  ```css
  @theme { --color-brand: light-dark(#c2410c, #fb923c); --color-brand-soft: light-dark(#fff1e8, #2a1a10); }
  ```
- **Light and dark.** The app follows the mode of Solus; never force one mode. Define each color of your palette for both modes with `light-dark()`, as the starter does, and check that text on the accent reads in both. Solus also puts its theme in the page (`--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`); use them when the app must look like a part of the workspace.
- **Background.** Solus styles `html` and `body` of the page, and its styles win over yours. Paint the app's background on its root element (`<div className="min-h-dvh bg-page text-ink">` in the starter), not on `html` or `body`.
- **Type.** Use a real scale: a page title of 24px to 30px with tight tracking (a headline on the first page can be larger, as in the starter), section labels, 13px to 14px body text, 11px to 12px for meta text, `tabular-nums` for numbers, and a mono face for code and ids. No text below 11px. `--font-sans` is the face of the workspace. For a face of your own, install a `@fontsource-variable/<name>` package and import it in `src/main.tsx`; the build puts the font in the page. Each family adds about 250 KiB to the page for each style, so use one display face and the system face for body text.
- **Icons.** The starter has `lucide-react`. Use icons in the navigation, on buttons, in empty states, and for status. 16px, stroke width 1.75. An icon-only button needs an accessible name.
- **Shell.** Navigation that fits the app: a sidebar with the wordmark, the sections, and the things the user made (connections, lists, boards), or a top bar with tabs. Each page has a header: where the user is, one line that says what the page is for, and the primary action. In a narrow window the sidebar becomes a drawer behind a menu button.
- **First open.** Never a blank form. Show what the app is for and the one action that starts it, in a compact panel: once the user has things of their own, those come first. Where it helps, offer sample data to explore, marked as a sample, that the user can remove.
- **Depth.** Build what a person expects from this kind of app, not only what the user named, and nothing that goes against the request (a reader of data gets no edit dialog): search, sort, filter, pages with counts, a detail view of one row, a `<dialog>` to create and to edit, copy and export, a confirm or an undo for a delete, and keyboard shortcuts for repeated actions.
- **States.** A quiet busy state that keeps the last data on screen. An empty state with an icon, one sentence, and an action. An error with the message and a way to try again. A disabled control that says why. Status as a badge with a dot and a label.
- **Finish.** Spacing in steps of 4px, hairline borders, one radius scale, hover and `focus-visible` on every control, color transitions of 150ms, `text-wrap: balance` on titles, and truncation with a `title` for long values. No placeholder text and no placeholder art.

Write the controls the app needs as its own components, in its own style. Native elements (`<button>`, `<input>`, `<select>`, `<dialog>`) with your classes are enough; add a component library only when the app needs what it has.

## Access and motion

- Every control works with the keyboard and shows visible focus. Dragging has a keyboard alternative.
- Every input has a label. Color is never the only signal: pair it with a label or a shape.
- A chart shows its values on hover, on keyboard focus, and on touch, with units, and has a summary or a table.
- Motion is finite and makes a change clear. No continuous decoration and no entrance effect on each input. Respect reduced motion (the starter's stylesheet does).

## Check the design

Look at each preview as the user will: would a person take this for a product that a team shipped? If it reads as a form, a debug view, a default page, or Notes with new words, design it again before you deploy. Compare it with the brief: the tone, the accent, the face, the shell, and the signature must show on the first screen. Check each state in a preview: first open with no data, loading, an error from an operation with a way to try again, a long list, every page, a narrow window, and dark mode. Show real data; never put a hard-coded array where live data belongs.
