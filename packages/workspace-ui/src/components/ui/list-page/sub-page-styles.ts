// The sub page band's control recipes, shared by the band and by the record
// pages that put their own controls in its action slot, so a task's chip and a
// pull request's switcher take the same geometry at every rung.
//
// Three rungs, the same three the list pages use: the desktop measure, the
// laptop measure (`.is-laptop-display`, fenced behind `pointer-fine:` so it
// never outranks the touch rung), and the touch measure for a thumb. Every
// laptop box is exactly 4px under its desktop box, so the row keeps one rhythm.

/** A crumb segment or the leaf: a quiet text button in the band's own type. */
export const SUB_PAGE_CRUMB_BTN =
  'flex h-7 shrink-0 cursor-pointer items-center rounded border-0 bg-transparent px-[7px] text-muted-foreground transition-colors hover:bg-[var(--wash-1)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-9 pointer-fine:[.is-laptop-display_&]:h-6 [.is-laptop-display_&]:px-1.5'

/** A plain segment beside the buttons, on the same line and measure. */
export const SUB_PAGE_CRUMB_TEXT =
  'flex h-7 shrink-0 items-center px-[7px] text-muted-foreground pointer-coarse:h-9 pointer-fine:[.is-laptop-display_&]:h-6 [.is-laptop-display_&]:px-1.5'

/** A round icon control: stepper arrows, pane controls, a record's verbs. */
export const SUB_PAGE_ROUND_BTN =
  'flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:size-9 pointer-fine:[.is-laptop-display_&]:size-[22px]'

/** A pill chip in the action slot: an upstream state, a provider mark. */
export const SUB_PAGE_CHIP =
  'flex h-[26px] shrink-0 items-center gap-[7px] rounded-full px-2.5 text-xs text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)] pointer-fine:[.is-laptop-display_&]:h-[22px] [.is-laptop-display_&]:px-2'

/** The glyph inside a round control, one step smaller on a laptop display. */
export const SUB_PAGE_ICON = '[.is-laptop-display_&]:size-[11px]'
