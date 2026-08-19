// `cn` lives in `lib/tw.ts` beside the tailwind-merge config and `tv`, so both
// merge paths share one set of registered `@theme` keys. It is re-exported here
// because `components.json` points shadcn-svelte's `utils` alias at this file.
export { cn } from './tw'

// Type helpers used by shadcn-svelte generated components.
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null }
