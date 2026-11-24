// The sub page band's control recipes, shared by the band and by the record
// pages that put their own controls in its action slot, so a task's chip and a
// pull request's switcher take the same geometry at every rung.
//
// Two rungs, the same two the list pages use: the desktop measure and the
// touch measure for a thumb.

/** A crumb segment or the leaf: a quiet text button in the band's own type. */
export const SUB_PAGE_CRUMB_BTN =
  'flex h-7 shrink-0 cursor-pointer items-center rounded border-0 bg-transparent px-[7px] text-muted-foreground transition-colors hover:bg-[var(--wash-1)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:tap-area'

/** A plain segment beside the buttons, on the same line and measure. */
export const SUB_PAGE_CRUMB_TEXT =
  'flex h-7 shrink-0 items-center px-[7px] text-muted-foreground'

/** A pill chip in the action slot: an upstream state, a provider mark. The
 *  same height and type as the band's pill groups (`PAGE_PILL_GROUP`), as the
 *  review panel's change chip is beside its pill. */
export const SUB_PAGE_CHIP =
  'flex h-8 shrink-0 items-center gap-[7px] rounded-full bg-background px-2.5 text-workspace-chrome text-muted-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]'
