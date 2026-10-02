# Single density

Status: done. This replaces the laptop display tier that ADR-0010 and ADR-0013
described.

## Decision

Solus renders one density on every display. The app does not read the monitor
size to choose type or geometry. A user who wants a denser or a roomier
interface uses zoom:

- Desktop: `mod+plus`, `mod+minus`, and `mod+0`. Each step is 10%. The factor is
  saved per device, and every display starts at 100%.
- Web and mobile: the browser owns zoom.
- The "Interface size" setting scales the reading content (`--solus-font-scale`).

Layout still adapts to two real facts:

- The container a surface renders in (`@container` rungs such as `pane`,
  `composer`, and `rail`).
- The pointer (`pointer-coarse:`) for touch targets.

## Why

The laptop tier added `html.is-laptop-display` when `screen.width <= 1600`. It
had these problems:

- Every phone and tablet also matched it. Its variants had two selectors, so
  they won against the `pointer-coarse:` touch rungs and the container rungs
  beside them. Many rules needed `pointer-fine:` fences and `!` markers to work
  around this.
- It made laptops denser in two ways at the same time: smaller type rungs and a
  90% first-run zoom. The result, for example 10.8px chrome text, was denser
  than peer apps. Those apps use one compact density and leave
  the rest to zoom.
- It doubled the design surface. Each rung had a desktop value and a laptop
  value, and about 150 component files carried laptop variants.

## What changed

- Removed `html.is-laptop-display`, `runtime.isLaptopDisplay`,
  `isLaptopDisplay()`, `LAPTOP_SCREEN_MAX_WIDTH`, `logicalDisplayWidth()`, and
  `defaultZoomFactorForScreen()`.
- Removed the laptop token block in `workspace.css`, every
  `[.is-laptop-display_&]:` variant, and every `:global(html.is-laptop-display)`
  rule. The desktop values are now the only values.
- JS metrics that followed the display (pull request rail row heights, the
  autocomplete menu width, the code-intel reference list height, and the
  document outline margin gate) now use their desktop values.
- Removed the `laptop-outranks-touch` rule from `lint:layout`.
- `tests/unit/single-density.test.ts` fails if a display-size class returns.

## Known effects

- A user who already has a saved 90% zoom from the old first-run seed keeps it.
  `mod+0` returns to 100%. There is no migration.
- On a laptop, some surfaces now show the desktop geometry. Examples are menu
  rows, list page bands, transcript cards, and the composer toolbar. Container
  rungs still control narrow panes.
- The document outline no longer opens automatically at the top of a document
  in a shell narrower than 1408px. It still opens on hover, on pin, and on a
  keyboard jump.

## Dense supporting text

Peer apps use 12px for supporting text in a sidebar and in side panels, and
14px for titles. Solus follows this:

- A session row's project and host line uses `text-chrome-dense`. The title
  stays on `text-workspace-chrome`.
- The project panel declares `text-chrome-dense` on the rail, and its rows
  inherit it.

`text-chrome-dense` is 12px with a precise pointer and 14px on touch, so phones
and tablets keep the readable size.

Rows in the project panel and controls in the input bar use 16px icons and a
500 weight on their labels, as peer apps do. The weight and the icon carry the
presence that the smaller type gives up. Body text, titles, and the transcript
stay at the face's own weight. The branch name at the top of the project panel
uses 600, so it stays one step heavier than the rows below it.

## Task icon

Use `packages/workspace-ui/src/components/ui/TaskIcon.svelte` for task
navigation, task links, and task actions on desktop, web, and mobile. It is
the rounded square with a checkmark used in the session breadcrumb. Review,
checklist, and status icons keep their own meanings.
