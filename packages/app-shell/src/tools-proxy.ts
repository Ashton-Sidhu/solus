/**
 * The callable paths an app reaches the host through (docs/plans/apps.md §4):
 * `tools.<integration>.<tool>(args)` for an integration, and
 * `server.<function>(input)` for one of the app's own host functions. Each is
 * one call; `.queryOptions(args)` and `.mutationOptions()` hand the same call
 * to TanStack Query with keys built from the path, so a mutation can
 * invalidate the reads of its path with `.pathFilter()`.
 *
 * Nothing here knows about frames or call names: the transport is injected.
 */

import { mutationOptions, queryOptions, type QueryFilters, type QueryKey, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query'
import type { ToolArguments, ToolValue } from './host-bridge'

export interface ToolCallRequest {
  path: readonly string[]
  args: ToolArguments
}

export type ToolCallTransport = (request: ToolCallRequest) => Promise<ToolValue>

/** The wire name of a path: the slug, then the tool's own name joined as it was written. */
export function toolWireName(path: readonly string[]): string {
  const [slug, ...tool] = path
  return `${slug}/${tool.join('.')}`
}

/** The call name of a host function: `@server/<function>` (`appFunctionCallName` in `@solus/contracts/apps`). */
export function functionWireName(path: readonly string[]): string {
  return `@server/${path.join('.')}`
}

/** What a proxy is rooted at, and how many segments a path needs before it names a call. */
export interface CallProxyRoot {
  /** The object's name in the app's code, used in query keys and messages. */
  name: 'tools' | 'server'
  /** 2 for `tools.<integration>.<tool>`; 1 for `server.<function>`. */
  depth: number
  /** What to write instead, when a path is too short to name a call. */
  usage: string
}

export const TOOLS_ROOT: CallProxyRoot = { name: 'tools', depth: 2, usage: 'tools.<integration>.<tool>(args)' }
export const SERVER_ROOT: CallProxyRoot = { name: 'server', depth: 1, usage: 'server.<function>(input)' }

type QueryExtras = Omit<UseQueryOptions, 'queryKey' | 'queryFn'>
type MutationExtras = Omit<UseMutationOptions<ToolValue, Error, ToolArguments | undefined>, 'mutationKey' | 'mutationFn'>

/** The helpers at call depth, built for one path. Each is a plain function, so it survives being destructured. */
function helpers(root: CallProxyRoot, path: string[], transport: ToolCallTransport) {
  const pathKey = (): QueryKey => [`solus-${root.name}`, ...path]
  const queryKey = (args?: ToolArguments): QueryKey => [...pathKey(), { args: args ?? {}, type: 'query' }]
  const mutationKey = (): QueryKey => [...pathKey(), { type: 'mutation' }]
  return {
    queryOptions: (args?: ToolArguments, extras?: QueryExtras) =>
      queryOptions({ ...extras, queryKey: queryKey(args), queryFn: () => transport({ path, args: args ?? {} }) }),
    queryKey,
    mutationOptions: (extras?: MutationExtras) =>
      mutationOptions({ ...extras, mutationKey: mutationKey(), mutationFn: (args: ToolArguments | undefined) => transport({ path, args: args ?? {} }) }),
    mutationKey,
    pathKey,
    pathFilter: (filters?: Omit<QueryFilters, 'queryKey'>): QueryFilters => ({ ...filters, queryKey: pathKey() }),
  }
}

type Helpers = ReturnType<typeof helpers>
type Helper = keyof Helpers
type ToolTarget = ((args?: ToolArguments) => Promise<ToolValue>) & Helpers
/** What a component sees at any depth of `tools` or `server`: a callable path with the query helpers, and every deeper path. */
export type ToolPath = ToolTarget & { [segment: string]: ToolPath }
const HELPER_NAMES = new Set<string>(['queryOptions', 'queryKey', 'mutationOptions', 'mutationKey', 'pathKey', 'pathFilter'])

export function createCallProxy(root: CallProxyRoot, transport: ToolCallTransport): ToolPath {
  const nest = (path: string[]): ToolPath => {
    const call = (args?: ToolArguments): Promise<ToolValue> => {
      if (path.length < root.depth) return Promise.reject(new Error(`${[root.name, ...path].join('.')} names nothing to call. Write ${root.usage}.`))
      return transport({ path, args: args ?? {} })
    }
    const target: ToolTarget = Object.assign(call, helpers(root, path, transport))
    const proxy = new Proxy(target, {
      get(own, key) {
        // A symbol key (`Symbol.toPrimitive`, inspection) and `then` must stay undefined, or an await would never settle.
        const name = String(key)
        if (key !== name || name === 'then' || name === 'toJSON') return undefined
        if (path.length >= root.depth && HELPER_NAMES.has(name)) {
          // SAFETY: `HELPER_NAMES` holds exactly the keys of `Helpers`.
          return own[name as Helper]
        }
        return nest([...path, name])
      },
    })
    // SAFETY: the trap above answers every string key with a deeper path or a helper, which is the open shape `ToolPath` declares.
    return proxy as ToolPath
  }
  return nest([])
}
