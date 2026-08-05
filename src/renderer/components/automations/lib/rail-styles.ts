// Shared chrome for the detail view's rail, split across the Schedule and Setup
// blocks. The rail has exactly two type styles — a 0.78125rem label/value pair
// and a 0.75rem mono value — and one rhythm, so these live in one place rather
// than being restated per block.

/** A muted label opposite its value on a 1.875rem rhythm. No dividers, no
 *  zebra: the rhythm carries the list. */
export const ROW = 'flex h-7.5 items-center justify-between gap-3 text-[13px]'
/** A value is identified by its position opposite a muted label, not by weight. */
export const VALUE = 'min-w-0 truncate font-[430] text-foreground'
/** Mono is for ids, paths and clock times only — never a second body face. */
export const MONO_VALUE = 'min-w-0 truncate font-mono text-[13px] font-[430] tabular-nums text-foreground'
export const EYEBROW = 'text-[12px] font-[450] tracking-[0.09em] text-muted-foreground uppercase'

/** Trigger for an editable value — the input bar's model / permission chip at
 *  rail scale: borderless until hover, a caret to mark it editable (static
 *  values never get one), and the same press-scale every picker in the app has.
 *  The negative margin keeps the value text optically flush with the card edge
 *  while the hover wash keeps its padding. */
export const VALUE_TRIGGER =
  '-mr-1.5 flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-1.5 ' +
  'text-[13px] font-[430] text-foreground transition-[background-color,color,scale] ' +
  'hover:bg-muted active:scale-[0.96] ' +
  'focus-visible:bg-(--solus-accent-light) focus-visible:outline-none ' +
  'pointer-coarse:h-10 pointer-coarse:px-2'

/** Borderless right-aligned field for the rail's typed values (clock time,
 *  interval amount, cron expression). `max-md:text-[…]` is restated on purpose:
 *  Input's stock `max-md:text-base` is its own tailwind-merge group, so a bare
 *  size never displaces it. */
export const RAIL_FIELD =
  '-mr-1.5 h-7 rounded-md border-0 bg-transparent px-1.5 py-0 text-right font-mono text-[13px] max-md:text-[13px] font-[430] tabular-nums ' +
  'text-foreground transition-colors duration-120 hover:bg-muted ' +
  'focus-visible:bg-(--solus-accent-light) focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-0 ' +
  'focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] ' +
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ' +
  '[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:p-0 [.dark_&]:[color-scheme:dark] ' +
  'pointer-coarse:h-10 pointer-coarse:text-[13px]'
