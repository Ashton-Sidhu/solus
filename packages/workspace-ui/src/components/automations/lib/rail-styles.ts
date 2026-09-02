// Shared chrome for the detail view's rail, split across the Schedule and Setup
// blocks. The rail has exactly two type rungs — the workspace chrome rung for
// label/value rows and the metadata rung for block eyebrows — and one rhythm,
// so these live in one place rather than being restated per block.

/** A muted label opposite its value on a 1.875rem rhythm. No dividers, no
 *  zebra: the rhythm carries the list. */
export const ROW = 'flex h-7.5 items-center justify-between gap-3 text-workspace-chrome [.is-laptop-display_&]:h-7'
/** A value is identified by its position opposite a muted label, not by weight. */
export const VALUE = 'min-w-0 truncate font-normal text-foreground'
/** Mono is for ids, paths and clock times only — never a second body face. */
export const MONO_VALUE = 'min-w-0 truncate text-workspace-chrome font-normal tabular-nums text-foreground'
/** Every block label in the detail view — Schedule, Setup, History, and the
 *  stat strip's Next / Last / Health. Labels are metadata, so they sit one rung
 *  under the values they head and every one of them is the same size. */
export const EYEBROW = 'text-xs font-normal text-muted-foreground uppercase'

/** Trigger for an editable value — the input bar's model / permission chip at
 *  rail scale: borderless until hover, a caret to mark it editable (static
 *  values never get one), and the same press-scale every picker in the app has.
 *  The negative margin keeps the value text optically flush with the card edge
 *  while the hover wash keeps its padding. */
export const VALUE_TRIGGER =
  '-mr-1.5 flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-1.5 ' +
  'text-workspace-chrome font-normal text-foreground transition-[background-color,color,scale] ' +
  'pointer-fine:[.is-laptop-display_&]:h-6 ' +
  'hover:bg-muted active:scale-[0.96] ' +
  'focus-visible:bg-(--solus-accent-light) focus-visible:outline-none ' +
  'pointer-coarse:h-10 pointer-coarse:px-2'

/** Borderless right-aligned field for the rail's typed values (clock time,
 *  interval amount, cron expression). `max-md:text-[…]` is restated on purpose:
 *  Input's mobile default is breakpoint-prefixed, which makes it its own
 *  tailwind-merge group, so a bare size never displaces it. Still true now that
 *  the default inherits rather than pinning 14px — a breakpoint-prefixed
 *  `inherit` outranks an unprefixed rung just as the old size did. */
export const RAIL_FIELD =
  '-mr-1.5 h-7 rounded-md border-0 bg-transparent px-1.5 py-0 text-right text-workspace-chrome max-md:text-workspace-chrome font-normal tabular-nums ' +
  'pointer-fine:[.is-laptop-display_&]:h-6 ' +
  'text-foreground transition-colors duration-120 hover:bg-muted ' +
  'focus-visible:bg-(--solus-accent-light) focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-0 ' +
  'focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] ' +
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ' +
  '[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:p-0 [.dark_&]:[color-scheme:dark] ' +
  'pointer-coarse:h-10'
