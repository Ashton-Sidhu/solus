/**
 * The `tools` object a component reaches an integration through
 * (docs/plans/apps.md §4). `tools.linear.issues.list({ team })` is one call;
 * `.queryOptions(args)` and `.mutationOptions()` hand the same call to
 * TanStack Query with keys built from the path, so a mutation can invalidate
 * the reads of its path with `.pathFilter()`.
 *
 * The first segment is the integration's slug and the rest is the upstream
 * tool's name; the wire name is `<slug>/<tool>`. Nothing here knows about
 * frames: the transport is injected.
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

const pathKey = (path: readonly string[]): QueryKey => ['solus-tool', ...path]
const queryKey = (path: readonly string[], args: ToolArguments | undefined): QueryKey => [...pathKey(path), { args: args ?? {}, type: 'query' }]
const mutationKey = (path: readonly string[]): QueryKey => [...pathKey(path), { type: 'mutation' }]

type QueryExtras = Omit<UseQueryOptions, 'queryKey' | 'queryFn'>
type MutationExtras = Omit<UseMutationOptions<ToolValue, Error, ToolArguments | undefined>, 'mutationKey' | 'mutationFn'>

/** The helpers at tool depth, built for one path. Each is a plain function, so it survives being destructured. */
function helpers(path: string[], transport: ToolCallTransport) {
  return {
    queryOptions: (args?: ToolArguments, extras?: QueryExtras) =>
      queryOptions({ ...extras, queryKey: queryKey(path, args), queryFn: () => transport({ path, args: args ?? {} }) }),
    queryKey: (args?: ToolArguments) => queryKey(path, args),
    mutationOptions: (extras?: MutationExtras) =>
      mutationOptions({ ...extras, mutationKey: mutationKey(path), mutationFn: (args: ToolArguments | undefined) => transport({ path, args: args ?? {} }) }),
    mutationKey: () => mutationKey(path),
    pathKey: () => pathKey(path),
    pathFilter: (filters?: Omit<QueryFilters, 'queryKey'>): QueryFilters => ({ ...filters, queryKey: pathKey(path) }),
  }
}

type Helpers = ReturnType<typeof helpers>
type Helper = keyof Helpers
type ToolTarget = ((args?: ToolArguments) => Promise<ToolValue>) & Helpers
/** What a component sees at any depth of `tools`: a callable path with the query helpers, and every deeper path. */
export type ToolPath = ToolTarget & { [segment: string]: ToolPath }
const HELPER_NAMES = new Set<string>(['queryOptions', 'queryKey', 'mutationOptions', 'mutationKey', 'pathKey', 'pathFilter'])

export function createToolsProxy(transport: ToolCallTransport): ToolPath {
  const nest = (path: string[]): ToolPath => {
    const call = (args?: ToolArguments): Promise<ToolValue> => {
      if (path.length < 2) return Promise.reject(new Error(`tools.${path.join('.')} names no tool. Write tools.<integration>.<tool>(args).`))
      return transport({ path, args: args ?? {} })
    }
    const target: ToolTarget = Object.assign(call, helpers(path, transport))
    const proxy = new Proxy(target, {
      get(own, key) {
        // A symbol key (`Symbol.toPrimitive`, inspection) and `then` must stay undefined, or an await would never settle.
        const name = String(key)
        if (key !== name || name === 'then' || name === 'toJSON') return undefined
        if (path.length >= 2 && HELPER_NAMES.has(name)) {
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
