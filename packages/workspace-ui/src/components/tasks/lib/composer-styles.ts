// The composer's footer row and its portalled pickers are one control read in
// two places: a property is a word until you reach for it, and the row it opens
// answers in the same voice. Both shapes repeat across every property, so they
// are declared once here rather than restated on each control.

/** One property as an outlined chip. The hairline border marks each property
 *  as a control the user can set, so the row reads as a set of fields rather
 *  than loose words. Every control in the property row shares this shape. */
export const PROPERTY_TRIGGER =
  "inline-flex h-7 min-w-0 items-center gap-1.5 overflow-hidden cursor-pointer rounded-md border border-(--solus-container-border) bg-transparent px-2 text-[0.8125rem] font-medium text-(--solus-text-secondary) outline-none transition-colors duration-150 hover:border-(--solus-popover-border) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:border-(--solus-accent) focus-visible:text-(--solus-text-primary) disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"

export const PICKER_OPTION =
  "flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-secondary text-(--solus-text-secondary) cursor-pointer outline-none transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) data-[selected=true]:font-medium data-[selected=true]:text-(--solus-text-primary)"
