// `@solus/app`: what an app's UI reaches its Solus host through. A project is
// an app when it has an `app.ts` (see the create-app skill); in a
// plain artifact every call below fails with a message that says so.
//
// Do not edit. This file holds no protocol: Solus puts `window.solusApp` in
// the page, and may change how it carries a call without a rebuild.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelCall } from './solus-app-backend'

export type { ModelCall }

/** A JSON value: all a call answers. What a call takes is sent as JSON too, so pass plain data. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

declare global {
  interface Window {
    solusApp?: {
      call(name: string, args: object): Promise<unknown>
      on?(listener: (event: string, detail?: unknown) => void): () => void
      /** True only in the app's own window of the Solus desktop app. */
      desktop?: boolean
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

/** Shared client cache exposed to optimistic mutation updaters. */
export interface OptimisticQueryCache {
  /** The current cached value for one mounted query and input (including active optimistic updates), or undefined. */
  get<T = Json>(name: string, input?: object): T | undefined
  /** Optimistically sets the cached value for one mounted query and input until the mutation reconciles or fails. */
  set<T = Json>(name: string, input: object, value: T): void
  /** Optimistically transforms the cached value for one mounted query and input. */
  update<T = Json>(name: string, input: object, updater: (current: T | undefined) => T | undefined): void
  /** Optimistically transforms every mounted variant of a query, passing each variant's current value and input. */
  updateAll<T = Json, Input extends object = object>(name: string, updater: (current: T | undefined, input: Input) => T | undefined): void
}

/** Options for `mutate`. */
export interface MutateOptions {
  /** Runs synchronously before the backend answers. Rolls back on failure and reconciles when `data-changed` refreshes queries. */
  optimistic?: (cache: OptimisticQueryCache) => void
}

/** Runs one mutation of `app.ts`. When it changes the app's data, every `useQuery` of every open UI runs again. */
export function mutate<T = Json>(name: string, input: object = {}, options?: MutateOptions): Promise<T> {
  if (!options?.optimistic) return call<T>(`@app/${name}`, input)
  const transaction = beginOptimistic(options.optimistic)
  if ('error' in transaction) return Promise.reject(transaction.error)
  return call<T>(`@app/${name}`, input).then(
    (result) => {
      transaction.settle()
      return result
    },
    (error: unknown) => {
      transaction.rollback()
      throw error
    },
  )
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

interface QuerySnapshot {
  data: unknown
  error: string | null
  loading: boolean
}

interface OptimisticPatch {
  transactionId: number
  startedAtGeneration: number
  updater: (current: unknown) => unknown
  settled: boolean
  reconcileAtGeneration: number | null
}

interface CacheEntry {
  key: string
  callName: string
  queryName: string | null
  input: object
  serverData: unknown
  error: string | null
  loading: boolean
  requestId: number
  fetchGeneration: number
  completedGeneration: number
  patches: OptimisticPatch[]
  listeners: Set<() => void>
  snapshot: QuerySnapshot
}

const INITIAL_SNAPSHOT: QuerySnapshot = { data: undefined, error: null, loading: true }
const queryCache = new Map<string, CacheEntry>()
let nextTransactionId = 1
let stopCacheDataChanged: (() => void) | null = null

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

function cacheKey(callName: string, inputKey: string): string {
  return `${callName}\0${inputKey}`
}

function recomputeEntry(entry: CacheEntry): void {
  let data = entry.serverData
  for (const patch of entry.patches) data = patch.updater(data)
  if (Object.is(entry.snapshot.data, data) && entry.snapshot.error === entry.error && entry.snapshot.loading === entry.loading) return
  entry.snapshot = { data, error: entry.error, loading: entry.loading }
  for (const listener of entry.listeners) listener()
}

function fetchEntry(entry: CacheEntry): void {
  const requestId = ++entry.requestId
  const generation = ++entry.fetchGeneration
  entry.loading = true
  recomputeEntry(entry)
  call<unknown>(entry.callName, entry.input).then(
    (data) => {
      if (entry.requestId !== requestId) return
      entry.serverData = data
      entry.error = null
      entry.loading = false
      entry.completedGeneration = generation
      entry.patches = entry.patches.filter((patch) => !(patch.settled && patch.reconcileAtGeneration !== null && generation >= patch.reconcileAtGeneration))
      recomputeEntry(entry)
    },
    (error: unknown) => {
      if (entry.requestId !== requestId) return
      entry.error = error instanceof Error ? error.message : String(error)
      entry.loading = false
      recomputeEntry(entry)
    },
  )
}

function ensureDataChangedSubscription(): void {
  if (stopCacheDataChanged) return
  stopCacheDataChanged = onDataChanged(() => {
    for (const entry of queryCache.values()) fetchEntry(entry)
  })
}

function releaseDataChangedSubscription(): void {
  if (queryCache.size > 0 || !stopCacheDataChanged) return
  stopCacheDataChanged()
  stopCacheDataChanged = null
}

function subscribeQuery(callName: string, inputKey: string, listener: () => void): () => void {
  const key = cacheKey(callName, inputKey)
  let entry = queryCache.get(key)
  const isNew = !entry
  if (!entry) {
    entry = {
      key,
      callName,
      queryName: callName.startsWith('@app/') ? callName.slice(5) : null,
      input: JSON.parse(inputKey) as object,
      serverData: undefined,
      error: null,
      loading: true,
      requestId: 0,
      fetchGeneration: 0,
      completedGeneration: 0,
      patches: [],
      listeners: new Set(),
      snapshot: INITIAL_SNAPSHOT,
    }
    queryCache.set(key, entry)
  }
  entry.listeners.add(listener)
  ensureDataChangedSubscription()
  if (isNew) fetchEntry(entry)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0) {
      entry.requestId += 1
      queryCache.delete(key)
      releaseDataChangedSubscription()
    }
  }
}

function getQuerySnapshot(key: string): QuerySnapshot {
  return queryCache.get(key)?.snapshot ?? INITIAL_SNAPSHOT
}

function refreshQuery(callName: string, inputKey: string): void {
  const entry = queryCache.get(cacheKey(callName, inputKey))
  if (entry) fetchEntry(entry)
}

function beginOptimistic(apply: (cache: OptimisticQueryCache) => void): { settle(): void; rollback(): void } | { error: unknown } {
  const transactionId = nextTransactionId++
  const touched = new Set<CacheEntry>()

  const rollback = () => {
    for (const entry of touched) {
      const before = entry.patches.length
      entry.patches = entry.patches.filter((patch) => patch.transactionId !== transactionId)
      if (entry.patches.length !== before) recomputeEntry(entry)
    }
  }

  const settle = () => {
    for (const entry of touched) {
      let removed = false
      const remaining: OptimisticPatch[] = []
      for (const patch of entry.patches) {
        if (patch.transactionId !== transactionId) {
          remaining.push(patch)
          continue
        }
        // A refresh that started after this mutation and already completed carries the server result.
        if (!entry.loading && entry.completedGeneration > patch.startedAtGeneration) {
          removed = true
          continue
        }
        patch.settled = true
        patch.reconcileAtGeneration = entry.loading && entry.fetchGeneration > patch.startedAtGeneration
          ? entry.fetchGeneration
          : entry.fetchGeneration + 1
        remaining.push(patch)
      }
      entry.patches = remaining
      if (removed) recomputeEntry(entry)
    }
  }

  const cache: OptimisticQueryCache = {
    get<T = Json>(name: string, input: object = {}): T | undefined {
      const entry = queryCache.get(cacheKey(`@app/${name}`, stableStringify(input)))
      return entry ? (entry.snapshot.data as T | undefined) : undefined
    },
    set<T = Json>(name: string, input: object, value: T): void {
      cache.update<T>(name, input, () => value)
    },
    update<T = Json>(name: string, input: object, updater: (current: T | undefined) => T | undefined): void {
      const entry = queryCache.get(cacheKey(`@app/${name}`, stableStringify(input)))
      if (!entry) return
      entry.patches.push({
        transactionId,
        startedAtGeneration: entry.fetchGeneration,
        updater: (current) => updater(current as T | undefined),
        settled: false,
        reconcileAtGeneration: null,
      })
      touched.add(entry)
      recomputeEntry(entry)
    },
    updateAll<T = Json, Input extends object = object>(name: string, updater: (current: T | undefined, input: Input) => T | undefined): void {
      for (const entry of queryCache.values()) {
        if (entry.queryName !== name) continue
        entry.patches.push({
          transactionId,
          startedAtGeneration: entry.fetchGeneration,
          updater: (current) => updater(current as T | undefined, entry.input as Input),
          settled: false,
          reconcileAtGeneration: null,
        })
        touched.add(entry)
        recomputeEntry(entry)
      }
    },
  }

  try {
    apply(cache)
  } catch (error) {
    rollback()
    return { error }
  }
  return { settle, rollback }
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
  const inputKey = stableStringify(input)
  const key = cacheKey(callName, inputKey)
  const subscribe = useCallback((listener: () => void) => subscribeQuery(callName, inputKey, listener), [callName, inputKey])
  const getSnapshot = useCallback(() => getQuerySnapshot(key), [key])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const previous = useRef<{ callName: string; data: T | undefined }>({ callName, data: undefined })
  useLayoutEffect(() => {
    if (previous.current.callName !== callName) {
      previous.current = { callName, data: snapshot.data as T | undefined }
      return
    }
    if (snapshot.data !== undefined) previous.current.data = snapshot.data as T
  }, [callName, snapshot.data])
  const previousData = previous.current.callName === callName ? previous.current.data : undefined
  const data = snapshot.data === undefined && snapshot.loading ? previousData : (snapshot.data as T | undefined)
  const refresh = useCallback(() => refreshQuery(callName, inputKey), [callName, inputKey])
  return { data, error: snapshot.error, loading: snapshot.loading, refresh }
}

type Operations<App> = App extends { operations: infer Declared } ? Declared : never
type NameOf<App, Kind extends 'query' | 'mutation'> = { [Name in keyof Operations<App>]: Operations<App>[Name] extends { kind: Kind } ? Name : never }[keyof Operations<App>] & string
type InputOf<App, Name extends keyof Operations<App>> = Operations<App>[Name] extends { readonly inputType?: infer Input } ? Input : never
type OutputOf<App, Name extends keyof Operations<App>> = Operations<App>[Name] extends { readonly outputType?: infer Output } ? Output : never
type ConfigOf<App> = App extends { config?: infer Declared } ? { readonly [Name in keyof NonNullable<Declared>]: NonNullable<Declared>[Name] extends { type: 'model' } ? string : NonNullable<Declared>[Name] extends { default: infer Value } ? Value : never } : never

/** Typed client cache exposed to `appClient().mutate(..., { optimistic })`. */
export interface TypedOptimisticQueryCache<App> {
  get<Name extends NameOf<App, 'query'>>(name: Name, input: InputOf<App, Name>): OutputOf<App, Name> | undefined
  set<Name extends NameOf<App, 'query'>>(name: Name, input: InputOf<App, Name>, value: OutputOf<App, Name>): void
  update<Name extends NameOf<App, 'query'>>(name: Name, input: InputOf<App, Name>, updater: (current: OutputOf<App, Name> | undefined) => OutputOf<App, Name> | undefined): void
  updateAll<Name extends NameOf<App, 'query'>>(name: Name, updater: (current: OutputOf<App, Name> | undefined, input: InputOf<App, Name>) => OutputOf<App, Name> | undefined): void
}

/** Typed options for `appClient().mutate`. */
export interface TypedMutateOptions<App> {
  optimistic?: (cache: TypedOptimisticQueryCache<App>) => void
}

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
    mutate: <Name extends NameOf<App, 'mutation'>>(name: Name, input: InputOf<App, Name>, options?: TypedMutateOptions<App>) =>
      mutate<OutputOf<App, Name>>(name, input as object, options as MutateOptions | undefined),
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

// ─── The desktop app ───
//
// Native capabilities for the app in its own window of the Solus desktop app.
// Anywhere else (in Solus on the web, on a phone, in the workspace) `available`
// is false, `permission` and `requestPermission` resolve "unavailable", every
// other call rejects with `DesktopUnavailable`, and a listener does nothing.

/** A capability the person allows or refuses for this app, once, on this computer. */
export type DesktopPermission = 'menuBar' | 'shortcuts' | 'floating' | 'startAtLogin' | 'microphone' | 'camera' | 'systemAudio' | 'clipboardRead' | 'notifications'
/** `prompt`: the person has not answered, and the next call asks. */
export type DesktopPermissionState = 'granted' | 'denied' | 'prompt' | 'unavailable'

/** The app is not in its own window of the Solus desktop app. */
export class DesktopUnavailable extends Error {
  constructor(message = 'This needs the app in its own window of the Solus desktop app.') {
    super(message)
    this.name = 'DesktopUnavailable'
  }
}
/** The person did not allow this capability for the app. Only they change it, in the app's menu or in Solus Settings. */
export class DesktopPermissionDenied extends Error {
  constructor(message: string, readonly permission: DesktopPermission) {
    super(message)
    this.name = 'DesktopPermissionDenied'
  }
}
/** Another app, another program, or Solus holds these keys. */
export class ShortcutTaken extends Error {
  constructor(message: string, readonly accelerator: string) {
    super(message)
    this.name = 'ShortcutTaken'
  }
}
/** The input is not one the desktop app takes, such as a title that is too long. */
export class DesktopInvalidInput extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopInvalidInput'
  }
}
/**
 * macOS has not allowed Solus to record system audio. The desktop app offered
 * System Settings; the person turns on Solus under Privacy & Security > Screen
 * & System Audio Recording, reopens Solus, and tries again.
 */
export class SystemAudioBlocked extends Error {
  constructor(message = 'macOS has not allowed Solus to record system audio.') {
    super(message)
    this.name = 'SystemAudioBlocked'
  }
}
export type DesktopError = DesktopUnavailable | DesktopPermissionDenied | ShortcutTaken | DesktopInvalidInput | SystemAudioBlocked

type DesktopFailure =
  | { code: 'DesktopUnavailable'; message: string }
  | { code: 'DesktopPermissionDenied'; message: string; permission: DesktopPermission }
  | { code: 'ShortcutTaken'; message: string; accelerator: string }
  | { code: 'DesktopInvalidInput'; message: string }
  | { code: 'SystemAudioBlocked'; message: string }

function desktopError(reason: unknown): unknown {
  const failure = reason instanceof Error ? (reason as Error & { failure?: DesktopFailure }).failure : undefined
  switch (failure?.code) {
    case 'DesktopUnavailable': return new DesktopUnavailable(failure.message)
    case 'DesktopPermissionDenied': return new DesktopPermissionDenied(failure.message, failure.permission)
    case 'ShortcutTaken': return new ShortcutTaken(failure.message, failure.accelerator)
    case 'DesktopInvalidInput': return new DesktopInvalidInput(failure.message)
    case 'SystemAudioBlocked': return new SystemAudioBlocked(failure.message)
    default: return reason
  }
}

function desktopCall<T>(operation: string, args: object = {}): Promise<T> {
  if (!desktop.available) return Promise.reject(new DesktopUnavailable())
  return call<T>(`@desktop/${operation}`, args).catch((reason: unknown) => { throw desktopError(reason) })
}

/** Calls `listener` with the detail of each desktop event of one kind. */
function onDesktopEvent(event: string, listener: (detail: { [key: string]: unknown }) => void): () => void {
  if (!desktop.available) return () => undefined
  return window.solusApp?.on?.((name, detail) => {
    if (name === event && typeof detail === 'object' && detail !== null) listener(detail as { [key: string]: unknown })
  }) ?? (() => undefined)
}

export const desktop = {
  /** Whether the app is in its own window of the Solus desktop app. */
  get available(): boolean {
    return typeof window !== 'undefined' && window.solusApp?.desktop === true
  },
  /** The person's answer for one capability, without asking. */
  permission: (name: DesktopPermission): Promise<DesktopPermissionState> =>
    desktop.available ? desktopCall('permission', { name }) : Promise.resolve('unavailable'),
  /**
   * Asks the person now, if they have not answered, and resolves their answer;
   * a refusal resolves "denied". Use it for `startAtLogin`, which no other call
   * asks for, or before a recording starts.
   */
  requestPermission: (name: DesktopPermission): Promise<DesktopPermissionState> =>
    desktop.available ? desktopCall('request-permission', { name }) : Promise.resolve('unavailable'),
  menuBar: {
    /**
     * Shows the app in the menu bar (macOS) or the system tray, with this text:
     * at most 24 characters, or null for the app's name. Its menu opens the app.
     * Needs `menuBar`. While it shows, closing the window hides it and the app
     * keeps running.
     */
    setTitle: (text: string | null): Promise<void> => desktopCall('menu-bar-title', { text }),
  },
  shortcuts: {
    /**
     * Calls `handler` when the person presses `accelerator` anywhere on the
     * computer, such as "CommandOrControl+Shift+K" (Electron's accelerator
     * syntax). Resolves the function that removes it. Needs `shortcuts`; at most
     * 8 an app. Rejects with `ShortcutTaken` when another program holds the keys.
     */
    register: async (accelerator: string, handler: () => void): Promise<() => Promise<void>> => {
      const { id } = await desktopCall<{ id: string }>('shortcut-register', { accelerator })
      const stop = onDesktopEvent('desktop-shortcut', (detail) => { if (detail.id === id) handler() })
      return async () => {
        stop()
        await desktopCall('shortcut-unregister', { id })
      }
    },
  },
  window: {
    /** Keeps the window above other windows, or stops. Needs `floating`. */
    setFloating: (on: boolean): Promise<void> => desktopCall('floating', { on }),
    show: (): Promise<void> => desktopCall('window', { action: 'show' }),
    /** Hides the window. The page keeps running. */
    hide: (): Promise<void> => desktopCall('window', { action: 'hide' }),
    /** Shows the window and brings it in front of every other app, such as from a shortcut's handler. */
    focus: (): Promise<void> => desktopCall('window', { action: 'focus' }),
    /** Hides the window when it shows and has focus; else shows and focuses it. */
    toggle: (): Promise<void> => desktopCall('window', { action: 'toggle' }),
    onFocus: (handler: () => void): (() => void) => onDesktopEvent('desktop-window', (detail) => { if (detail.type === 'focus') handler() }),
    onBlur: (handler: () => void): (() => void) => onDesktopEvent('desktop-window', (detail) => { if (detail.type === 'blur') handler() }),
  },
  badge: {
    /** A count on the app's icon: 1 to 99999; null or 0 removes it. Needs no permission. */
    set: (count: number | null): Promise<void> => desktopCall('badge', { count }),
  },
  /**
   * Shows a system notification. A click brings the window to the front, and
   * `route` (a page after "#", such as "#/reports/42") opens that page. Needs
   * `notifications`. The web `Notification` API does not work in an app's page.
   */
  notify: (notification: { title: string; body?: string; route?: string }): Promise<void> => desktopCall('notify', notification),
  clipboard: {
    /** The text on the clipboard. Needs `clipboardRead`. */
    readText: (): Promise<string> => desktopCall('clipboard-read'),
  },
  audio: {
    /**
     * Everything this computer plays, such as the other people in a call, as
     * an audio-only `MediaStream`. Call it from a click or a key press. Needs
     * `systemAudio`, asked the first time; the first call after the question
     * can need a second click. Rejects with `SystemAudioBlocked` when macOS has
     * not allowed Solus to record it, and with `DesktopUnavailable` where this
     * computer cannot give it (macOS before 13, or Linux with no PulseAudio or
     * PipeWire sound server). Stop its tracks when you are done.
     */
    system: async (): Promise<MediaStream> => {
      await desktopCall('system-audio')
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }).catch(async (reason: unknown) => {
        // The grant or the system's access may have changed since: the desktop app says which.
        await desktopCall('system-audio')
        throw reason
      })
      for (const track of stream.getVideoTracks()) {
        track.stop()
        stream.removeTrack(track)
      }
      if (stream.getAudioTracks().length === 0) throw new DesktopUnavailable('This computer gave no system audio.')
      return stream
    },
  },
}

/** Holds a global shortcut while the component is mounted. Gives why the latest registration failed, or null. */
export function useDesktopShortcut(accelerator: string, handler: () => void): DesktopError | null {
  const latest = useRef(handler)
  useLayoutEffect(() => { latest.current = handler })
  const [failure, setFailure] = useState<{ accelerator: string; error: DesktopError } | null>(null)
  useEffect(() => {
    if (!desktop.available) return
    let isActive = true
    const registration = desktop.shortcuts.register(accelerator, () => { if (isActive) latest.current() })
    registration.then(
      () => { if (isActive) setFailure(null) },
      (error: DesktopError) => { if (isActive) setFailure({ accelerator, error }) },
    )
    return () => {
      isActive = false
      void registration.then((remove) => remove(), () => undefined).catch(() => undefined)
    }
  }, [accelerator])
  return failure?.accelerator === accelerator ? failure.error : null
}

/** Calls `handler` each time the window gains or loses focus, such as to hide a window a shortcut showed. */
export function useDesktopWindowEvent(type: 'focus' | 'blur', handler: () => void): void {
  const latest = useRef(handler)
  useLayoutEffect(() => { latest.current = handler })
  useEffect(() => (type === 'focus' ? desktop.window.onFocus : desktop.window.onBlur)(() => latest.current()), [type])
}

/** Shows `count` on the app's icon while the component is mounted, and removes it after. Gives why the latest change failed, or null. */
export function useDesktopBadge(count: number | null): DesktopError | null {
  const [failure, setFailure] = useState<{ count: number | null; error: DesktopError } | null>(null)
  useEffect(() => {
    if (!desktop.available) return
    let isActive = true
    desktop.badge.set(count).then(
      () => { if (isActive) setFailure(null) },
      (error: DesktopError) => { if (isActive) setFailure({ count, error }) },
    )
    return () => { isActive = false }
  }, [count])
  useEffect(() => () => { if (desktop.available) void desktop.badge.set(null).catch(() => undefined) }, [])
  return failure?.count === count ? failure.error : null
}

/**
 * A capture of system audio that `start` begins (from a click) and `stop`
 * ends; it stops when the component unmounts. Gives the stream while it
 * runs, and why the latest start failed, or null.
 */
export function useSystemAudio(): { stream: MediaStream | null; error: DesktopError | Error | null; start(): Promise<void>; stop(): void } {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<DesktopError | Error | null>(null)
  const current = useRef<MediaStream | null>(null)
  const stop = useCallback(() => {
    for (const track of current.current?.getTracks() ?? []) track.stop()
    current.current = null
    setStream(null)
  }, [])
  const start = useCallback(async () => {
    stop()
    try {
      const next = await desktop.audio.system()
      current.current = next
      setStream(next)
      setError(null)
      // The person or the system can end the capture: the stream then has no live track.
      for (const track of next.getAudioTracks()) track.addEventListener('ended', () => { if (current.current === next) stop() })
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    }
  }, [stop])
  useEffect(() => stop, [stop])
  return { stream, error, start, stop }
}

/** The person's answer for one capability, read again each time the window gains focus. Undefined until it is read. */
export function useDesktopPermission(name: DesktopPermission): DesktopPermissionState | undefined {
  const [state, setState] = useState<{ name: DesktopPermission; value: DesktopPermissionState }>()
  useEffect(() => {
    let isActive = true
    const read = () => void desktop.permission(name).then((value) => { if (isActive) setState({ name, value }) }, () => undefined)
    read()
    const stop = desktop.window.onFocus(read)
    return () => {
      isActive = false
      stop()
    }
  }, [name])
  return state?.name === name ? state.value : undefined
}
