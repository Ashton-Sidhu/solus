// `@solus/app`: what an app reaches its Solus host through. A project is an
// app when it has an `app.json` (see the skill's references/apps.md); in a
// plain artifact every call below fails with a message that says so.
//
// Do not edit. This file holds no protocol: Solus puts `window.solusApp` in
// the page, and may change how it carries a call without a rebuild.

/** A JSON value: all a call answers. What a call takes is sent as JSON too, so pass plain data. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

declare global {
  interface Window {
    solusApp?: { call(name: string, args: object): Promise<unknown> }
  }
}

function call<T>(name: string, args: object): Promise<T> {
  const host = window.solusApp
  if (!host) return Promise.reject(new Error('This page has no Solus host: the project needs an app.json, and the page must be open in Solus.'))
  // The host answers what the call's caller declared; nothing checks it at run time.
  return host.call(name, args) as Promise<T>
}

/** The app's own data on the host. It belongs to the app, not to a viewer, and stays when the app is revised. */
export const storage = {
  /** The value kept under a key; null when there is none. */
  get: <T = Json>(key: string) => call<T | null>('@storage/get', { key }),
  /** Keeps a value that JSON can hold: 1 MiB a value, 8 MiB for the whole app. */
  set: (key: string, value: unknown) => call<null>('@storage/set', { key, value }).then(() => undefined),
  delete: (key: string) => call<null>('@storage/delete', { key }).then(() => undefined),
  keys: () => call<string[]>('@storage/keys', {}),
}

/** One call to the host. `T` is the type you expect back; nothing checks it at run time. */
export type HostCall = (<T = Json>(input?: object) => Promise<T>) & { [segment: string]: HostCall }

function hostCalls(name: (path: string[]) => string, depth: number, usage: string): HostCall {
  const at = (path: string[]): HostCall =>
    new Proxy((() => undefined) as unknown as HostCall, {
      apply: (_target, _self, [input]: [object | undefined]) =>
        path.length < depth ? Promise.reject(new Error(`${usage} names nothing to call.`)) : call(name(path), input ?? {}),
      // `then` stays undefined, or an await of a path would never settle.
      get: (_target, key) => (typeof key !== 'string' || key === 'then' ? undefined : at([...path, key])),
    })
  return at([])
}

/** The app's own host functions: `server.rows({ table })` runs the export `rows` of `server.ts` on the host. */
export const server = hostCalls((path) => `@server/${path.join('.')}`, 1, 'server.<function>(input)')

/** The user's connected integrations: `tools.linear.list_issues({ team })`, with the viewer's own connection. */
export const tools = hostCalls(([slug, ...tool]) => `${slug}/${tool.join('.')}`, 2, 'tools.<integration>.<tool>(args)')
