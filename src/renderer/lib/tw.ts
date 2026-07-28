import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'
import { createTV } from 'tailwind-variants'

/**
 * Custom `@theme` keys are invisible to tailwind-merge — it only knows
 * Tailwind's stock scales, so it *guesses* the property group of anything else.
 * When the guess collides with a same-prefix class later in the list, the class
 * is deleted before it ever reaches the DOM: no warning, no build error.
 * `text-menu` was read as a colour and dropped against the
 * `text-(--solus-text-secondary)` that follows it on every menu row, leaving the
 * rows with no font-size at all and inheriting the 15–17px root.
 *
 * Register every custom `@theme` key here whose utility prefix belongs to a
 * different property group than tailwind-merge would assume. Bare-word colour
 * utilities are safe (an unknown word defaults to the colour group, which is
 * what a colour wants); sizes and other non-colour `text-*`/`font-*` keys are
 * not. `lib/utils.test.ts` fails if a key is added to `@theme` and missed here.
 */
export const twMergeConfig = {
  extend: {
    classGroups: {
      'font-size': ['text-menu', 'text-menu-meta'],
      'font-weight': ['font-secondary'],
    },
  },
}

const twMerge = extendTailwindMerge(twMergeConfig)

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * `tailwind-variants` bundles its *own* tailwind-merge instance, so configuring
 * `cn` does not configure `tv` — they are two independent merge paths.
 *
 * Always import `tv` from here. Importing it from the package reopens the hole,
 * and shadcn-svelte generates exactly that import every time you add a
 * variant-based primitive (`button`, `toggle`, `tabs`, …), so it comes back on
 * its own unless the guard test catches it.
 */
export const tv = createTV({ twMergeConfig })

export type { VariantProps } from 'tailwind-variants'
