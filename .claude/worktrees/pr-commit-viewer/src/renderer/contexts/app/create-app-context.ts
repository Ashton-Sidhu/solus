import { createContext } from 'svelte'

type ContextPair<T> = ReturnType<typeof createContext<T>>

const registryHost = globalThis as typeof globalThis & {
  __solusSvelteContexts?: Map<string, ContextPair<unknown>>
}

// Vite can replace a context module without remounting App. Keep the keys made
// by Svelte's createContext alive across those replacements so an updated lazy
// route still reads the context that the mounted app provided.
const registry = registryHost.__solusSvelteContexts ??= new Map()

export function createAppContext<T>(name: string): ContextPair<T> {
  const existing = registry.get(name)
  if (existing) return existing as ContextPair<T>

  const context = createContext<T>()
  registry.set(name, context as ContextPair<unknown>)
  return context
}
