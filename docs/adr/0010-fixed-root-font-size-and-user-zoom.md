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
- The **first-run default** for `zoomFactor` comes from the display, not from
  1.0: a laptop-class screen (logical width ≤ 1600px — the 14" MacBook Pro's
  1512 mode, the 1536px Windows 150% panel) starts one step out at 0.9.
  `defaultZoomFactorForScreen` in `src/shared/zoom.ts` owns the rule. This is a
  seed, not a curve: the renderer reads `screen.width` once, on a boot that
  found no settings blob, and persists the result immediately. Chromium reports
  `screen.width` in *zoomed* CSS pixels, so re-deriving it on a later boot would
  read the widened value and cancel the user's own zoom. Web and mobile skip the
  seed entirely — the bridge method is absent there, so the stored factor stays
  at 1.0 and the browser owns scaling as before.
- The user's **text-size preference** (`--solus-font-scale`) is unchanged and
  composes multiplicatively with zoom: zoom scales the whole UI, the text
  preference scales content text relative to chrome.

## Consequences

- Laptops that previously rendered at a 15px root now render ~7% larger. That is
  absorbed by zoom, not by re-tuning component sizes — do not reintroduce
  compensating scale factors in CSS. The screen-aware seed spends that step for
  the user on a fresh install instead of making them find the shortcut; every
  later change is theirs.
- Zoom changes how many CSS pixels the window reports, so a layout branch meant
  to describe the *machine* must not be a width media query. `isLaptopDisplay`
  (`contexts/app/viewport.ts`) reads `screen.width × zoomFactor` instead, and
  shares `LAPTOP_SCREEN_MAX_WIDTH` with the zoom seed. It replaced a
  `(max-width: 1800px)` query that moved a 1920px monitor onto the laptop branch
  at 110% zoom. Breakpoints that describe the *window* — mobile, compact — are
  still media queries and should stay that way.
- `mod+0` still resets to 100%, not to the seeded default. Reset means the
  neutral scale, as it does in VS Code and Slack, and re-deriving the seed there
  would hit the same zoomed-`screen.width` problem.
- px and rem now agree everywhere, permanently: `text-[0.75rem]` ≡ 12px on
  every display. The design standards express their values as rem tokens for
  consistency, not correctness, and "verify at three root sizes" steps are
  obsolete.
- Zoom is clamped in the main process as well as the renderer; a garbage factor
  from a stale settings blob can never wedge a window at an unreadable scale.
