// The band's crumbs, its three menus, and its trailing actions are one control
// read in a single pass, so their chrome is declared once here instead of being
// restated on every crumb, row, and action in the markup.

export const CRUMB_BUTTON =
  'flex h-[1.875rem] cursor-pointer items-center rounded px-[0.46875rem] transition-[background] duration-150 hover:bg-accent'

export const MENU_ROW =
  'flex h-[2.125rem] w-full cursor-pointer items-center gap-[0.5625rem] rounded-md px-[0.5625rem] text-left transition-[background] duration-150 hover:bg-accent'

/** The row's own title, which truncates before anything beside it does. */
export const MENU_LABEL = 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap'

/** The Projects and Sessions headings take the same rung as the task menu's
 *  Open/Completed pair: the three menus open off one band and are read in one
 *  pass, so they match or the band looks assembled. */
export const MENU_HEADING =
  'px-[0.5625rem] pt-1.5 pb-2.5 text-chrome-shelf font-medium text-muted-foreground uppercase'

/** Rows you can close reserve the slot the X lands in, so nothing reflows the
 *  moment a pointer crosses the row. The wash follows the row, not the pointer's
 *  exact target: reaching for the X must not read as leaving the row. */
export const MENU_ROW_CLOSABLE = `${MENU_ROW} pr-7 group-hover/row:bg-accent`

/** Task rows are Command rows, so they arrive carrying the app-wide menu rung
 *  (14px) while the project and session menus' plain rows inherit the dense rung
 *  from the surface. The band's three menus are one control read across one
 *  hover, so the task rows restate the surface's rung rather than standing a
 *  size above their own headings. */
export const TASK_MENU_ROW = `${MENU_ROW_CLOSABLE} text-chrome-dense`

export const ROW_STATUS = 'shrink-0 text-xs font-medium whitespace-nowrap'

/** The X that closes a row, revealed by the row's own hover. */
export const ROW_CLOSE =
  'absolute top-1/2 right-[0.4375rem] flex size-[1.125rem] -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-[opacity,background,color] duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100'

export const BAND_ACTION =
  'flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground'

/** The band's one labelled action, Share: the raised pill the band's window
 *  controls use, widened to carry the word beside the glyph, so the two read
 *  as one family. */
export const BAND_SHARE =
  'no-drag pointer-events-auto inline-flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-background pl-2.5 pr-3 text-xs font-medium text-[color-mix(in_oklch,var(--foreground)_75%,transparent)] shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors hover:bg-[var(--wash-1)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border) pointer-coarse:h-10'
