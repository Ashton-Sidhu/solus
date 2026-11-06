import { menuRowVariants } from '../../ui/menu/menu-row'

// Shared chrome for the detail view's rail. The rail is the model picker laid
// open on the page: the menu surface, `menu-heading` group labels, hairlines
// between blocks, and rows of the same size and ink as a menu's. These live in
// one place so the Schedule, Setup and History blocks cannot drift apart.

/** A row that shows a value or holds its own control (a switch, a field). It
 *  takes a menu row's metrics but no hover wash: it is not a target. */
export const ROW =
  'flex min-h-8 items-center justify-between gap-2.5 rounded-lg px-2.5 text-menu text-(--solus-text-secondary) pointer-coarse:min-h-11'
/** A row that is a target, the same way the model picker's Agent row is: the
 *  whole row washes on hover and stays lit while its menu is open. */
export const ROW_BUTTON =
  menuRowVariants({ stagger: false }) +
  ' w-full border-0 bg-transparent text-left data-open:text-(--solus-text-primary) data-open:shadow-[inset_0_0_0_62rem_var(--solus-menu-hover-ink)] ' +
  'focus-visible:bg-(--solus-accent-light) focus-visible:outline-none'
/** The quiet half of a row, the way the model picker sets "Agent". */
export const LABEL = 'shrink-0 text-(--solus-text-tertiary)'
export const VALUE = 'min-w-0 truncate'
/** A block label outside the rail (Next, Last, Instructions), in the face of the
 *  rail's `menu-heading`. The padding belongs to a menu, so it stays there. */
export const EYEBROW = 'text-menu-heading leading-none font-medium tracking-[0.09em] text-(--solus-text-tertiary) uppercase'

/** Borderless right-aligned field for the rail's typed values (clock time,
 *  interval amount, cron expression). `max-md:text-[…]` is restated on purpose:
 *  Input's mobile default is breakpoint-prefixed, which makes it its own
 *  tailwind-merge group, so a bare size never displaces it. Still true now that
 *  the default inherits rather than pinning 14px — a breakpoint-prefixed
 *  `inherit` outranks an unprefixed rung just as the old size did. */
export const RAIL_FIELD =
  '-mr-1.5 h-7 rounded-lg border-0 bg-transparent px-1.5 py-0 text-right text-workspace-chrome max-md:text-workspace-chrome font-normal tabular-nums ' +
  'text-(--solus-text-secondary) transition-colors duration-120 hover:bg-(--solus-menu-hover-ink) ' +
  'focus-visible:bg-muted focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-0 ' +
  'focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] ' +
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ' +
  '[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:p-0 [.dark_&]:[color-scheme:dark] ' +
  'pointer-coarse:h-10'
