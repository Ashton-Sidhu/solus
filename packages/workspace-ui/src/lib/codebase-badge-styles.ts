import type { CodebaseColor } from '@solus/contracts/codebase-badge'

/**
 * The classes of each badge colour of a codebase (`codebase-badge.ts`). Each
 * class is written out in full, so Tailwind finds it. `badge`: the front card
 * with the letters. `card`: the card behind it. `swatch`: the colour's dot in
 * the picker. The badge reads in light and dark mode: an opaque tint with
 * strong ink, as the project badge has.
 */
export const CODEBASE_BADGE_STYLES = {
  gray: {
    badge: 'bg-gray-100 text-gray-700 dark:bg-gray-950 dark:text-gray-300',
    card: 'bg-gray-400/60 dark:bg-gray-400/45',
    swatch: 'bg-gray-500',
  },
  red: {
    badge: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    card: 'bg-red-400/60 dark:bg-red-400/45',
    swatch: 'bg-red-500',
  },
  orange: {
    badge: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
    card: 'bg-orange-400/60 dark:bg-orange-400/45',
    swatch: 'bg-orange-500',
  },
  amber: {
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    card: 'bg-amber-400/60 dark:bg-amber-400/45',
    swatch: 'bg-amber-500',
  },
  yellow: {
    badge: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300',
    card: 'bg-yellow-400/60 dark:bg-yellow-400/45',
    swatch: 'bg-yellow-500',
  },
  lime: {
    badge: 'bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300',
    card: 'bg-lime-400/60 dark:bg-lime-400/45',
    swatch: 'bg-lime-500',
  },
  green: {
    badge: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
    card: 'bg-green-400/60 dark:bg-green-400/45',
    swatch: 'bg-green-500',
  },
  emerald: {
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    card: 'bg-emerald-400/60 dark:bg-emerald-400/45',
    swatch: 'bg-emerald-500',
  },
  teal: {
    badge: 'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
    card: 'bg-teal-400/60 dark:bg-teal-400/45',
    swatch: 'bg-teal-500',
  },
  cyan: {
    badge: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300',
    card: 'bg-cyan-400/60 dark:bg-cyan-400/45',
    swatch: 'bg-cyan-500',
  },
  sky: {
    badge: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    card: 'bg-sky-400/60 dark:bg-sky-400/45',
    swatch: 'bg-sky-500',
  },
  blue: {
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    card: 'bg-blue-400/60 dark:bg-blue-400/45',
    swatch: 'bg-blue-500',
  },
  indigo: {
    badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
    card: 'bg-indigo-400/60 dark:bg-indigo-400/45',
    swatch: 'bg-indigo-500',
  },
  violet: {
    badge: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    card: 'bg-violet-400/60 dark:bg-violet-400/45',
    swatch: 'bg-violet-500',
  },
  purple: {
    badge: 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300',
    card: 'bg-purple-400/60 dark:bg-purple-400/45',
    swatch: 'bg-purple-500',
  },
  fuchsia: {
    badge: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300',
    card: 'bg-fuchsia-400/60 dark:bg-fuchsia-400/45',
    swatch: 'bg-fuchsia-500',
  },
  pink: {
    badge: 'bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300',
    card: 'bg-pink-400/60 dark:bg-pink-400/45',
    swatch: 'bg-pink-500',
  },
  rose: {
    badge: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
    card: 'bg-rose-400/60 dark:bg-rose-400/45',
    swatch: 'bg-rose-500',
  },
} satisfies Record<CodebaseColor, { badge: string; card: string; swatch: string }>
