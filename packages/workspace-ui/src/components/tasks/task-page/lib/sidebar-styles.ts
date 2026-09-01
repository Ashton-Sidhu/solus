// The sidebar is one list of properties on a single rhythm, and it has two
// homes: a 308px column beside the task, and a sheet raised over it where that
// column has nowhere to be. The rhythm differs between them and nothing else
// does — a 34px row with the label in a fixed lead column reads as a properties
// list next to prose, and as a cramped one under a thumb, where the rung is a
// 54px row with the label leading and the value at the far edge.
//
// Declared once here, as functions of which home the sidebar is in, so the two
// forms cannot drift apart row by row (ADR-0013: type is declared on a surface).
// The sheet is portalled to the body, so a container query would never reach it;
// this is the boolean that stands in for one.

/** One property line. */
export const row = (sheet: boolean): string =>
  sheet ? 'flex h-[54px] items-center gap-[11px] px-3.5' : 'flex h-[34px] items-center'

/** The label opposite a property's value. */
export const rowLabel = (sheet: boolean): string =>
  sheet
    ? 'min-w-0 flex-1 text-muted-foreground'
    : 'w-[78px] shrink-0 pl-0.5 text-xs text-muted-foreground'

/** A value you can open — the same box as a static value, plus a hover wash.
 *  In the column it takes the row's remaining width; in the sheet it sits at
 *  the trailing edge, sized to the value it holds. */
export const valueButton = (sheet: boolean): string =>
  sheet
    ? 'flex h-[34px] cursor-pointer items-center gap-2 rounded-md px-2 font-medium active:bg-[var(--wash-2)]'
    : 'flex h-[34px] flex-1 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-[var(--wash-2)]'

/** A block of properties. Whitespace alone separates one from the next in the
 *  column, which already sits on a card; in the sheet each block is its own
 *  card, with a hairline between its rows. */
export const group = (sheet: boolean): string =>
  sheet
    ? 'flex flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)] [&>*+*]:border-t [&>*+*]:border-[var(--hairline)]'
    : 'flex flex-col gap-1 px-3.5 pt-[15px] pb-4'
