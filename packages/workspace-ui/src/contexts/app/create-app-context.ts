import { createContext } from 'svelte'

type ContextPair<T> = ReturnType<typeof createContext<T>>

declare global {
  var __solusSvelteContexts: Map<string, ContextPair<never>> | undefined
}

// Vite can replace a context module without remounting App. Keep the keys made
// by Svelte's createContext alive across those replacements so an updated lazy
// route still reads the context that the mounted app provided.
const registry = globalThis.__solusSvelteContexts ??= new Map()

export function createAppContext<T>(name: string): ContextPair<T> {
  const existing = registry.get(name)
  if (existing) {
    // SAFETY: Each registry key is created once for one declared context type and survives only hot-module replacement.
    return existing as ContextPair<T>
  }

  const context = createContext<T>()
  // SAFETY: The registry never reads a context without the same generic owner that created this key.
  registry.set(name, context as ContextPair<never>)
  return context
}
