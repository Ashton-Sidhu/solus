// The composer's footer row and its portalled pickers are one control read in
// two places: a property is a word until you reach for it, and the row it opens
// answers in the same voice. Both shapes repeat across every property, so they
// are declared once here rather than restated on each control.

/** One property, stated plainly. No border, no fill, no track — a property is a
 *  word until you reach for it, and only then does it take a surface. Every
 *  control in the footer row shares this shape, so nothing competes. */
export const PROPERTY_TRIGGER =
  "inline-flex min-w-0 items-center gap-1.5 cursor-pointer rounded-lg border-0 bg-transparent px-1.5 py-1 text-(--solus-text-tertiary) outline-none transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"

/** An option row inside a picker popover. */
export const PICKER_OPTION =
  "flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-secondary text-(--solus-text-secondary) cursor-pointer outline-none transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) data-[selected=true]:font-medium data-[selected=true]:text-(--solus-text-primary)"
