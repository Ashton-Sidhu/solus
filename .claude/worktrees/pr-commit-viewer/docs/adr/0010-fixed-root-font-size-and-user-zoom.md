# ADR-0010 — The root font-size is fixed; users zoom

**Status**: accepted

## Context

The desktop renderer used to set the root font-size fluidly from the monitor's
physical resolution (`lib/uiScale.ts`): 15px on common laptop screens, 17px at
an 1800px benchmark, 16px at 1920px and above. Every rem in the app scaled with
it, so the UI was automatically denser on smaller screens.

That automation had three growing costs:

- **Surface divergence.** Only the desktop renderer called `initRootScaling`;
  the web client always ran at the browser's 16px root. The same monitor showed
  two different UI scales depending on which client was open.
- **Unit drift.** Values written in px — icon `size={N}` props, letter-spacing,
  a growing crop of `text-[12px]` / `rounded-[10px]` utilities — did not scale
  with the root, so px and rem spellings of "the same size" rendered
  differently on laptops. The design-standards audit (July–August 2026) found
  hundreds of such sites, and the split kept regenerating.
- **Second-guessing the OS.** macOS scaled resolutions and Windows display
  scaling already exist for choosing density; a screen-width curve on top of
  them fights the resolution the user picked, and there is no way to opt out.

CSS cannot express "scale by physical screen, not window" natively — media
queries and viewport units measure the window — so keeping the behavior meant
keeping custom JS forever.

## Decision

- The root font-size is the browser default **16px** on every surface.
  `uiScale.ts` is deleted; nothing writes `documentElement.style.fontSize`.
- Whole-UI scaling is **user-controlled zoom**, the industry-native desktop
  pattern (VS Code, Slack): `mod+equal` / `mod+minus` / `mod+0` step a
  persisted `zoomFactor` (0.5–2.0 in 10% steps, `src/shared/zoom.ts`), applied
  per-window through `webContents.setZoomFactor`. The factor lives in the
  renderer settings blob; the pill and editor windows sync live through the
  `storage` event so they never show two scales.
- On **web and mobile**, the browser's own zoom fills the role. The zoom
  keybindings register disabled there so `mod+equal`/`mod+minus` fall through
  to the browser untouched. This is a deliberate platform split: the shell
  capability is native to each surface.
- The user's **text-size preference** (`--solus-font-scale`) is unchanged and
  composes multiplicatively with zoom: zoom scales the whole UI, the text
  preference scales content text relative to chrome.

## Consequences

- Laptops that previously rendered at a 15px root now render ~7% larger by
  default. That is absorbed by zooming out once, not by re-tuning component
  sizes — do not reintroduce compensating scale factors in CSS.
- px and rem now agree everywhere, permanently: `text-[0.75rem]` ≡ 12px on
  every display. The design standards express their values as rem tokens for
  consistency, not correctness, and "verify at three root sizes" steps are
  obsolete.
- Zoom is clamped in the main process as well as the renderer; a garbage factor
  from a stale settings blob can never wedge a window at an unreadable scale.
