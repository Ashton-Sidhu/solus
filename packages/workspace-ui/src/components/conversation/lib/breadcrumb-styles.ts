// The band's crumbs, its three menus, and its trailing actions are one control
// read in a single pass, so their chrome is declared once here instead of being
// restated on every crumb, row, and action in the markup.

/** A crumb in the band. */
export const CRUMB_BUTTON =
  'flex h-[1.875rem] cursor-pointer items-center rounded px-[0.46875rem] transition-[background] duration-150 hover:bg-accent'

/** A plain row in any of the band's menus. */
export const MENU_ROW =
  'flex h-[2.125rem] [.is-laptop-display_&]:h-[1.75rem] w-full cursor-pointer items-center gap-[0.5625rem] [.is-laptop-display_&]:gap-2 rounded-md px-[0.5625rem] text-left transition-[background] duration-150 hover:bg-accent'

/** The row's own title, which truncates before anything beside it does. */
export const MENU_LABEL = 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap'

/** The Projects and Sessions headings take the same laptop step as the task
 *  menu's Open/Completed pair: the three menus open off one band and are read in
 *  one pass, so they shrink together or the band looks assembled. */
export const MENU_HEADING =
  'px-[0.5625rem] pt-1.5 pb-2.5 [.is-laptop-display_&]:pt-1 [.is-laptop-display_&]:pb-2 text-chrome-shelf font-medium text-muted-foreground uppercase'

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

/** The short state word at the end of a row. */
export const ROW_STATUS = 'shrink-0 text-xs font-medium whitespace-nowrap'

/** The X that closes a row, revealed by the row's own hover. */
export const ROW_CLOSE =
  'absolute top-1/2 right-[0.4375rem] flex size-[1.125rem] -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-[opacity,background,color] duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100'

/** A trailing action on the band itself. */
export const BAND_ACTION =
  'flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground'
