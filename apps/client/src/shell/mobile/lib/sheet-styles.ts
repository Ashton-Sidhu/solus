// Chrome shared by the mobile bottom sheets. These four shapes are what makes a
// sheet read as one family — the card a group sits on, the label above it, the
// muted line under a row's title, and the stepper beside a value. They are
// declared once here because four sheets state them identically; anything only
// one sheet uses stays inline on its element.

export const SHEET_CARD = 'overflow-hidden rounded-2xl bg-(--card) shadow-[shadow:var(--elev-ring)]'

export const SHEET_SECTION_LABEL =
  'text-xs font-medium uppercase tracking-[0.12em] text-(--muted-foreground)'

export const SHEET_ROW_LABEL = 'text-sm font-medium text-(--solus-text-primary)'

export const SHEET_ROW_META = 'text-xs text-(--muted-foreground)'

export const SHEET_STEP_BUTTON =
  'flex h-9 w-11 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.94] disabled:opacity-35 disabled:active:scale-100 [-webkit-tap-highlight-color:transparent]'
