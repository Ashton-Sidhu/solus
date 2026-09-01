/**
 * The narrowing row's one recipe.
 *
 * Tasks, Pull requests, Automations and the Workspace all put a search field and
 * a run of filter chips under their page head. They had drifted into four
 * dialects of the same band — a 15px magnifier against a 16px one, a 26px menu
 * chip beside a 32px toggle pill, two different idle rings, and one field left
 * at 14px that iOS then zoomed the page into. This module is the single
 * statement of that band, so a reader moving between the four pages sees one
 * control, not four.
 *
 * Class lists live here rather than inline because they are shared by unrelated
 * importers (`ui/list-page/*` and `components/workspace/*`); a page-specific
 * class still belongs on the element that carries it.
 *
 * Two rungs. Above `@max-[30rem]/pane` the band is one 28px line. At the record
 * rung it becomes a 44px card over a scrolling row of 32px pills. Geometry at
 * the rung is marked `!`: a laptop-display variant is two selectors to the
 * rung's one and wins on specificity, and a coarse-pointer `min-h-10` from
 * `PAGE_GHOST_BTN` would otherwise make a sort chip 8px taller than the toggle
 * chip beside it.
 */

/** The field shell — elastic on a wide pane, a card at the record rung. */
export const FILTER_SEARCH_FIELD =
  'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg px-[9px] text-workspace-chrome shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)] @max-[30rem]/pane:h-11! @max-[30rem]/pane:flex-none @max-[30rem]/pane:gap-[9px] @max-[30rem]/pane:bg-card @max-[30rem]/pane:px-3 @max-[30rem]/pane:text-base! @max-[30rem]/pane:shadow-[shadow:var(--elev-ring)]'

/** The magnifier. 16px on a record, where it is the field's only label. */
export const FILTER_SEARCH_ICON =
  'shrink-0 text-muted-foreground opacity-70 @max-[30rem]/pane:size-4 @max-[30rem]/pane:opacity-100'

export const FILTER_SEARCH_INPUT =
  'w-full min-w-0 border-0 bg-transparent caret-[var(--primary)] outline-none placeholder:text-muted-foreground'

/** The keycap naming the key that focuses the field — absent where there is no
 *  keyboard for it to describe. */
export const FILTER_SEARCH_KEYCAP =
  'shrink-0 rounded-md bg-[var(--wash-2)] px-[7px] py-[3px] text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent),inset_0_-1px_0_color-mix(in_oklch,var(--foreground)_9%,transparent)] @max-[30rem]/pane:hidden'

/** A chip without its corners, for the one chip that is split in two
 *  (`ListScopeMenu`, whose ✕ takes the trailing half). */
export const FILTER_CHIP_UNROUNDED =
  'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 border-0 px-2.5 transition-colors duration-150 @max-[30rem]/pane:h-8! @max-[30rem]/pane:min-h-0! @max-[30rem]/pane:px-[13px]! [-webkit-tap-highlight-color:transparent]'

/** Every chip on the row, whatever it does: a toggle, a status menu, a sort. */
export const FILTER_CHIP = `${FILTER_CHIP_UNROUNDED} rounded-lg @max-[30rem]/pane:rounded-full`

/** Narrowing something. A list that is not showing everything says so on its
 *  face, not only when the chip is opened. */
export const FILTER_CHIP_ON =
  'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'

/** Idle. The ring is `inset` on purpose: a chip sits in a horizontal scroller,
 *  `overflow-x: auto` forces `overflow-y: auto` with it, and the row is exactly
 *  one chip tall — so an outer ring painted its top and bottom runs outside the
 *  scroll box and they were clipped away, leaving a pill with two curved ends
 *  and no lid. At half a pixel the two are indistinguishable, and an inset ring
 *  cannot be cut by an ancestor. */
export const FILTER_CHIP_OFF =
  'bg-transparent text-[color:var(--muted-foreground)] shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]'

/** The count a chip carries while it is off — once it is on, the number is the
 *  list itself. */
export const FILTER_CHIP_COUNT = 'text-xs tabular-nums opacity-60'

/** The chips' home: inline on a wide pane, one masked scroller on a record. */
export const FILTER_CHIP_ROW =
  'contents @max-[30rem]/pane:flex @max-[30rem]/pane:min-w-0 @max-[30rem]/pane:items-center @max-[30rem]/pane:gap-[7px] @max-[30rem]/pane:overflow-x-auto @max-[30rem]/pane:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] @max-[30rem]/pane:[scrollbar-width:none] @max-[30rem]/pane:[&::-webkit-scrollbar]:hidden'

/** `SortMenu`'s trigger, which merges its class over `PAGE_GHOST_BTN` — hence
 *  the `color:` hints, which are what let tailwind-merge drop the ghost
 *  button's own text colour instead of leaving both in the sheet. */
export const FILTER_SORT_CHIP = `${FILTER_CHIP} ${FILTER_CHIP_OFF} font-normal hover:bg-[var(--wash-2)] hover:text-foreground`
