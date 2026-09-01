// The plus menu is one long sheet of the same three shapes — a hero tile, a list
// row, and a segmented control — repeated for every action it offers. Declaring
// them once here keeps the sheet's markup readable as a list of actions rather
// than a wall of identical utility lists.

/** A large tile in the top row: glyph over word, pressed with a whole thumb. */
export const HERO_CARD =
  'flex h-22 flex-1 cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2xl border-0 bg-(--card) text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.96] disabled:opacity-40 disabled:active:scale-100 [-webkit-tap-highlight-color:transparent]'

/** The word under a hero tile's glyph. */
export const HERO_LABEL = 'font-medium'

/** A row in a grouped card. */
export const LIST_ROW =
  'flex min-h-[3.375rem] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 py-3 text-left transition-colors duration-[120ms] active:bg-(--wash-1) disabled:opacity-40 disabled:cursor-default disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]'

/** The fixed leading slot a row's glyph sits in, so titles line up down the card. */
export const LIST_ICON = 'flex w-5 shrink-0 items-center justify-center text-(--muted-foreground)'

/** A row's title, which truncates before its value does. */
export const LIST_LABEL = 'min-w-0 flex-1 truncate font-medium text-(--solus-text-primary)'

/** The current value opposite a row's title. */
export const LIST_VALUE = 'max-w-32 shrink-0 truncate text-(--muted-foreground)'

/** The hairline rule between two rows of one card. */
export const ROW_DIVIDER = 'h-px bg-(--hairline)'

/** The chevron that marks a row as a way into another surface. */
export const ROW_CHEVRON = 'shrink-0 text-(--muted-foreground) opacity-70'

/** The sheet body is a label surface; the lines that qualify a control step down
 *  from it. */
export const META_LINE = 'text-xs leading-[1.6] text-(--muted-foreground)'

/** The track a segmented control's options sit in. */
export const SEGMENT_GROUP =
  'flex gap-0.5 rounded-full bg-(--wash-2) p-[0.1875rem] shadow-[0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_9%,transparent)]'

/** The chosen option, lifted off the track. */
export const SEGMENT_ON =
  'flex h-9 flex-1 min-w-0 cursor-pointer items-center justify-center truncate rounded-full border-0 bg-(--card) font-semibold text-(--solus-text-primary) shadow-[inset_0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_12%,transparent)] [-webkit-tap-highlight-color:transparent]'

/** Every other option. */
export const SEGMENT_OFF =
  'flex h-9 flex-1 min-w-0 cursor-pointer items-center justify-center truncate rounded-full border-0 bg-transparent font-medium text-(--muted-foreground) [-webkit-tap-highlight-color:transparent]'
