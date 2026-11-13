// `@solus/app`: what an app's UI reaches its Solus host through. A project is
// an app when it has an `app.ts` (see the skill's references/apps.md); in a
// plain artifact every call below fails with a message that says so.
//
// Do not edit. This file holds no protocol: Solus puts `window.solusApp` in
// the page, and may change how it carries a call without a rebuild.

import { useCallback, useEffect, useState } from 'react'

/** A JSON value: all a call answers. What a call takes is sent as JSON too, so pass plain data. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

declare global {
  interface Window {
    solusApp?: {
      call(name: string, args: object): Promise<unknown>
      on?(listener: (event: string) => void): () => void
    }
  }
}

function call<T>(name: string, args: object): Promise<T> {
  const host = window.solusApp
  if (!host) return Promise.reject(new Error('This page has no Solus host: the project needs an app.ts, and the app must be open in Solus.'))
  // The host answers what the call's caller declared; nothing checks it at run time.
  return host.call(name, args) as Promise<T>
}

/** Runs one query of `app.ts`. `T` is the type you expect back; `appClient` gives it from the backend's own types. */
export function query<T = Json>(name: string, input: object = {}): Promise<T> {
  return call<T>(`@app/${name}`, input)
}

/** Runs one mutation of `app.ts`. When it changes the app's data, every `useQuery` of every open UI runs again. */
export function mutate<T = Json>(name: string, input: object = {}): Promise<T> {
  return call<T>(`@app/${name}`, input)
}

/** Calls `listener` when the app's data changed: this UI's own mutation, an agent, a schedule, or a webhook. Returns the way to stop. */
export function onDataChanged(listener: () => void): () => void {
  return window.solusApp?.on?.((event) => {
    if (event === 'data-changed') listener()
  }) ?? (() => undefined)
}

export interface QueryState<T> {
  /** The newest answer. It stays while a later run loads, so a refresh does not blank the screen. */
  data: T | undefined
  error: string | null
  loading: boolean
  refresh(): void
}

/** A query as React state. It runs when its name or input changes, and again each time the app's data changes. */
export function useQuery<T = Json>(name: string, input: object = {}): QueryState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [run, setRun] = useState(0)
  const key = JSON.stringify(input)
  useEffect(() => {
    let current = true
    setState((before) => ({ ...before, loading: true }))
    query<T>(name, JSON.parse(key) as object).then(
      (data) => { if (current) setState({ data, error: null, loading: false }) },
      (error: unknown) => { if (current) setState((before) => ({ data: before.data, error: error instanceof Error ? error.message : String(error), loading: false })) },
    )
    return () => { current = false }
  }, [name, key, run])
  const refresh = useCallback(() => setRun((count) => count + 1), [])
  useEffect(() => onDataChanged(refresh), [refresh])
  return { ...state, refresh }
}

type Operations<App> = App extends { operations: infer Declared } ? Declared : never
type NameOf<App, Kind extends 'query' | 'mutation'> = { [Name in keyof Operations<App>]: Operations<App>[Name] extends { kind: Kind } ? Name : never }[keyof Operations<App>] & string
type InputOf<App, Name extends keyof Operations<App>> = Operations<App>[Name] extends { readonly inputType?: infer Input } ? Input : never
type OutputOf<App, Name extends keyof Operations<App>> = Operations<App>[Name] extends { readonly outputType?: infer Output } ? Output : never

/**
 * The same three functions with the backend's own types:
 *
 *   import type app from '../app'
 *   const api = appClient<typeof app>()
 *   const notes = api.useQuery('list', {})
 *
 * The import is a type, so no backend code is in the UI.
 */
export function appClient<App>() {
  return {
    query: <Name extends NameOf<App, 'query'>>(name: Name, input: InputOf<App, Name>) => query<OutputOf<App, Name>>(name, input as object),
    mutate: <Name extends NameOf<App, 'mutation'>>(name: Name, input: InputOf<App, Name>) => mutate<OutputOf<App, Name>>(name, input as object),
    useQuery: <Name extends NameOf<App, 'query'>>(name: Name, input: InputOf<App, Name>) => useQuery<OutputOf<App, Name>>(name, input as object),
  }
}

/** The app's own key-value data on the host, for a UI with no backend. It belongs to the app, not to a viewer. */
export const storage = {
  /** The value kept under a key; null when there is none. */
  get: <T = Json>(key: string) => call<T | null>('@storage/get', { key }),
  /** Keeps a value that JSON can hold: 1 MiB a value, 8 MiB for the whole app. */
  set: (key: string, value: unknown) => call<null>('@storage/set', { key, value }).then(() => undefined),
  delete: (key: string) => call<null>('@storage/delete', { key }).then(() => undefined),
  keys: () => call<string[]>('@storage/keys', {}),
}

/** One call to an integration. `T` is the type you expect back; nothing checks it at run time. */
export type ToolCall = (<T = Json>(input?: object) => Promise<T>) & { [segment: string]: ToolCall }

function toolCalls(): ToolCall {
  const at = (path: string[]): ToolCall =>
    new Proxy((() => undefined) as unknown as ToolCall, {
      apply: (_target, _self, [input]: [object | undefined]) =>
        path.length < 2 ? Promise.reject(new Error('tools.<integration>.<tool>(args) names nothing to call.')) : call(`${path[0]}/${path.slice(1).join('.')}`, input ?? {}),
      // `then` stays undefined, or an await of a path would never settle.
      get: (_target, key) => (typeof key !== 'string' || key === 'then' ? undefined : at([...path, key])),
    })
  return at([])
}

/** The user's connected integrations: `tools.linear.list_issues({ team })`, with the viewer's own connection. Name each one in `integrations` in app.ts. */
export const tools = toolCalls()
