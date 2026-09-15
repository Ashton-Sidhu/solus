/**
 * Demo RPC arguments arrive as an untyped positional list, exactly as the real
 * transport delivers them. These readers are that boundary: a handler names the
 * parameter type its RPC method declares instead of asserting at each use site.
 */

export function arg<T>(args: unknown[], index: number): T {
  // SAFETY: the demo backend and the demo client ship in the same bundle, so every
  // call supplies the argument list its RPC method declares.
  return args[index] as T
}

export function optionalArg<T>(args: unknown[], index: number): T | undefined {
  // SAFETY: as `arg` above; an omitted positional argument reads as `undefined`.
  return args[index] as T | undefined
}

export function textArg(args: unknown[], index: number): string | null {
  const value = args[index]
  return typeof value === 'string' ? value : null
}
