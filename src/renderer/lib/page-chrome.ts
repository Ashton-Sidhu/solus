// Shared button chrome for the full-page library surfaces (Automations, Tasks,
// Folio, Plans). Kept as class strings rather than wrapper components so pages
// can attach their own handlers, aria attributes, and per-page variants.

/** The page's single primary action (New / Run now) — filled accent pill. */
export const PAGE_PRIMARY_BTN =
  'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-(--solus-accent) py-[0.4375rem] pl-2.5 pr-3 text-xs font-semibold text-[var(--solus-accent-contrast,#fff)] transition-[filter] duration-120 hover:brightness-[1.07] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-3.5 [@media(pointer:coarse)]:text-[0.8125rem]'

/** Quiet square icon button (close, refresh, row hover actions). */
export const PAGE_ICON_BTN =
  'relative inline-flex size-[1.625rem] cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out disabled:cursor-not-allowed disabled:opacity-35 [&:hover:not(:disabled)]:bg-(--solus-surface-hover) [&:hover:not(:disabled)]:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:size-11'

/** Borderless text/icon toggle for command bars (Starred, Mine, Bookmarked). */
export const PAGE_GHOST_BTN =
  'inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border-0 bg-transparent text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none'
