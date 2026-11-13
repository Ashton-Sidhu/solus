// `@solus/app`: what an app's UI reaches its Solus host through. A project is
// an app when it has an `app.ts` (see the create-app skill); in a
// plain artifact every call below fails with a message that says so.
//
// Do not edit. This file holds no protocol: Solus puts `window.solusApp` in
// the page, and may change how it carries a call without a rebuild.

import { useCallback, useEffect, useState } from 'react'
import type { ModelCall } from './solus-app-backend'

export type { ModelCall }

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
  return useCall<T>(`@app/${name}`, input)
}

/** One value of the app's config. */
export type ConfigValue = string | number | boolean

/** The app's config as React state: each field's value, or its default. It reads again when the owner changes a value on the Manage page. */
export function useConfig<T = { readonly [name: string]: ConfigValue }>(): QueryState<T> {
  return useCall<T>('@config/get', {})
}

function useCall<T>(callName: string, input: object): QueryState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [run, setRun] = useState(0)
  const key = JSON.stringify(input)
  useEffect(() => {
    let current = true
    setState((before) => ({ ...before, loading: true }))
    call<T>(callName, JSON.parse(key) as object).then(
      (data) => { if (current) setState({ data, error: null, loading: false }) },
      (error: unknown) => { if (current) setState((before) => ({ data: before.data, error: error instanceof Error ? error.message : String(error), loading: false })) },
    )
    return () => { current = false }
  }, [callName, key, run])
  const refresh = useCallback(() => setRun((count) => count + 1), [])
  useEffect(() => onDataChanged(refresh), [refresh])
  return { ...state, refresh }
}

type Operations<App> = App extends { operations: infer Declared } ? Declared : never
type NameOf<App, Kind extends 'query' | 'mutation'> = { [Name in keyof Operations<App>]: Operations<App>[Name] extends { kind: Kind } ? Name : never }[keyof Operations<App>] & string
type InputOf<App, Name extends keyof Operations<App>> = Operations<App>[Name] extends { readonly inputType?: infer Input } ? Input : never
type OutputOf<App, Name extends keyof Operations<App>> = Operations<App>[Name] extends { readonly outputType?: infer Output } ? Output : never
type ConfigOf<App> = App extends { config?: infer Declared } ? { readonly [Name in keyof NonNullable<Declared>]: NonNullable<Declared>[Name] extends { type: 'model' } ? string : NonNullable<Declared>[Name] extends { default: infer Value } ? Value : never } : never

/**
 * The same functions with the backend's own types:
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
    useConfig: () => useConfig<ConfigOf<App>>(),
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

/** One app file: a file the app holds, with a record. */
export interface AppFile {
  id: string
  name: string
  /** The media type. */
  type: string
  size: number
  createdAt: number
}

const FILE_PART_BYTES = 384 * 1024
const SAVE_MAX_BYTES = 16 * 1024 * 1024

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function readFile(file: AppFile | string): Promise<Blob> {
  const id = typeof file === 'string' ? file : file.id
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const part: { data: string; nextOffset: number | null } = await call('@files/read', { id, offset })
    parts.push(fromBase64(part.data))
    offset = part.nextOffset
  }
  return new Blob(parts, { type: typeof file === 'string' ? 'application/octet-stream' : file.type })
}

async function saveAs(name: string, data: Blob | string): Promise<void> {
  const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain' }) : data
  if (blob.size > SAVE_MAX_BYTES) throw new Error('A file the app gives you is at most 16 MiB.')
  await call('@client/save', { name, type: blob.type || 'application/octet-stream', data: toBase64(new Uint8Array(await blob.arrayBuffer())) })
}

/**
 * The app files: files the person gives the app and files the backend made.
 * Get a `File` from your own `<input type="file">` or a drop target, then
 * `upload` it and pass its `id` to a mutation, which reads it with
 * `ctx.files`. One file is at most 64 MiB.
 */
export const files = {
  /** Sends one file to the app. `onProgress` hears a number from 0 to 1. */
  async upload(file: Blob, name = file instanceof File ? file.name : 'file', onProgress?: (fraction: number) => void): Promise<AppFile> {
    const { uploadId } = await call<{ uploadId: string }>('@files/begin', { name, type: file.type || 'application/octet-stream', size: file.size })
    let index = 0
    for (let offset = 0; offset < file.size; offset += FILE_PART_BYTES) {
      const part = new Uint8Array(await file.slice(offset, offset + FILE_PART_BYTES).arrayBuffer())
      await call('@files/chunk', { uploadId, index, data: toBase64(part) })
      index += 1
      onProgress?.(Math.min(1, (offset + part.length) / file.size))
    }
    return call<AppFile>('@files/commit', { uploadId })
  },
  list: () => call<AppFile[]>('@files/list', {}),
  /** The bytes of one file. Pass the `AppFile` to get a `Blob` with its type. */
  read: readFile,
  /** An address for an `<img>`, an `<audio>`, or a `<video>`. Call `URL.revokeObjectURL` when it is no longer shown. */
  url: async (file: AppFile | string) => URL.createObjectURL(await readFile(file)),
  /** Gives the person one app file: a download on a computer, the share sheet on a phone. */
  save: async (file: AppFile) => saveAs(file.name, await readFile(file)),
  /** Gives the person a file the UI made, such as an export. At most 16 MiB. */
  saveAs,
  remove: (id: string) => call<null>('@files/remove', { id }).then(() => undefined),
}

/** The app files as React state. It reads again when the app's data or files change. */
export function useFiles(): QueryState<AppFile[]> {
  const [state, setState] = useState<{ data: AppFile[] | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [run, setRun] = useState(0)
  useEffect(() => {
    let current = true
    setState((before) => ({ ...before, loading: true }))
    files.list().then(
      (data) => { if (current) setState({ data, error: null, loading: false }) },
      (error: unknown) => { if (current) setState((before) => ({ data: before.data, error: error instanceof Error ? error.message : String(error), loading: false })) },
    )
    return () => { current = false }
  }, [run])
  const refresh = useCallback(() => setRun((count) => count + 1), [])
  useEffect(() => onDataChanged(refresh), [refresh])
  return { ...state, refresh }
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

// ─── Model calls (docs/plans/app-models.md) ───

/** What `@models/get` answers: the text from `textFrom` on, so a watcher reads only what is new. */
type ModelCallPart = ModelCall & { textFrom: number; textLength: number }

const MODEL_READ_EVERY_MS = 400
const MODEL_RETRY_MS = 2000

function isFinished(status: ModelCall['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

/** The app's model calls. The backend starts one (`ctx.models.start` in a mutation) and gives the UI its id. */
export const models = {
  get: (id: string) => call<ModelCall>('@models/get', { id }),
  /** Stops a queued or running call. */
  cancel: (id: string) => call<ModelCall>('@models/cancel', { id }),
  /**
   * Calls `onChange` with the call now, and again as it changes, until it
   * ends: its status, the text the model wrote so far, the operations it
   * called, and at the end its result or error. Returns the way to stop.
   */
  watch(id: string, onChange: (call: ModelCall) => void, onError?: (message: string) => void): () => void {
    let stopped = false
    let text = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      call<ModelCallPart>('@models/get', { id, textFrom: text.length }).then(
        (part) => {
          if (stopped) return
          text = text.slice(0, part.textFrom) + part.text
          onChange({ ...part, text })
          if (!isFinished(part.status)) timer = setTimeout(read, MODEL_READ_EVERY_MS)
        },
        (error: unknown) => {
          if (stopped) return
          onError?.(error instanceof Error ? error.message : String(error))
          timer = setTimeout(read, MODEL_RETRY_MS)
        },
      )
    }
    read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  },
}

/** One model call as React state, live until it ends. Pass null when there is no call yet. */
export function useModelCall(id: string | null): { call: ModelCall | null; error: string | null; cancel(): void } {
  const [state, setState] = useState<{ call: ModelCall | null; error: string | null }>({ call: null, error: null })
  useEffect(() => {
    setState({ call: null, error: null })
    if (!id) return
    return models.watch(id, (next) => setState({ call: next, error: null }), (error) => setState((before) => ({ ...before, error })))
  }, [id])
  const cancel = useCallback(() => {
    if (id) void models.cancel(id).catch((error: unknown) => setState((before) => ({ ...before, error: error instanceof Error ? error.message : String(error) })))
  }, [id])
  return { ...state, cancel }
}
