// The sidebar is one list of properties on a single rhythm: a 34px row with the
// label in a fixed lead column, which reads as a properties list next to prose.
// It has two homes — a 308px column beside the task, and a panel under the
// title where that column has nowhere to be — and the rows are the same in
// both. Declared once here so the rows cannot drift apart (ADR-0013: type is
// declared on a surface).

export const ROW = 'flex h-[34px] items-center'

export const ROW_LABEL = 'w-[78px] shrink-0 pl-0.5 text-xs text-muted-foreground'

/** A value you can open — the same box as a static value, plus a hover wash.
 *  It takes the row's remaining width. */
export const VALUE_BUTTON =
  'flex h-[34px] flex-1 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-[var(--wash-2)]'

/** The static twin of VALUE_BUTTON. */
export const VALUE = 'flex h-[34px] flex-1 items-center gap-2 px-2'

/** A block of properties. Whitespace alone separates one from the next: the
 *  column already sits on a card. */
export const GROUP = 'flex flex-col gap-1 px-3.5 pt-[15px] pb-4'
