import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export interface PortalCall {
  destination: string
  path: string
  interface: string
  member: string
  signature?: string
  body?: [string] | [string, Array<[string, [string, string | boolean]]>]
}

export interface PortalBus {
  connection: EventEmitter & { stream: { end(): void } }
  invoke(call: PortalCall, callback: (error: Error | null, value: string) => void): void
}

const dbus: { createClient(options: { busAddress?: string }): PortalBus } = createRequire(import.meta.url)('@homebridge/dbus-native')
const PORTAL = 'org.freedesktop.portal.Desktop'
const responseSchema = z.object({
  type: z.literal(4), path: z.string(), interface: z.literal('org.freedesktop.portal.Request'), member: z.literal('Response'),
  body: z.tuple([z.number().int(), z.array(z.tuple([z.string(), z.tuple([z.array(z.object({ type: z.string(), child: z.array(z.never()) })), z.array(z.union([z.string(), z.number(), z.boolean()]))])]))]),
})

export function screenshotPath(uri: string): string {
  const url = new URL(uri)
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) throw new Error('The screenshot portal returned an invalid file URI.')
  return fileURLToPath(url)
}

/** Subscribe before requesting capture: a portal may respond before its method returns. */
export function requestLinuxScreenshot(signal?: AbortSignal, createBus = () => dbus.createClient({}), timeoutMs = 120_000): Promise<string | null> {
  const bus = createBus()
  const token = `solus_${crypto.randomUUID().replaceAll('-', '')}`
  let requestPath: string | null = null
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, uri: string | null = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      bus.connection.removeListener('message', response)
      bus.connection.removeListener('error', failed)
      // Closing a disconnected D-Bus socket can emit another error.
      bus.connection.on('error', () => {})
      if (requestPath) {
        bus.invoke({ destination: PORTAL, path: requestPath, interface: 'org.freedesktop.portal.Request', member: 'Close' }, () => bus.connection.stream.end())
        // A broken portal must not keep the application alive waiting for Close.
        bus.connection.stream.end()
      } else bus.connection.stream.end()
      if (error) reject(error)
      else resolve(uri)
    }
    const failed = (error: Error) => finish(new Error(`Screenshot portal unavailable: ${error.message}`))
    const abort = () => finish(new Error('Screenshot capture was interrupted.'))
    const timer = setTimeout(() => finish(new Error('The screenshot portal did not respond. Try again.')), timeoutMs)
    timer.unref()
    const response = (message: z.input<typeof responseSchema>) => {
      if (!message.path?.endsWith('/' + token)) return
      const parsed = responseSchema.safeParse(message)
      if (!parsed.success) return
      requestPath = parsed.data.path
      const [code, values] = parsed.data.body
      if (code === 1) return finish(null)
      if (code !== 0) return finish(new Error('The desktop could not take a screenshot. Check screenshot portal access.'))
      const uri = z.string().safeParse(values.find(([name]) => name === 'uri')?.[1][1][0])
      if (!uri.success) return finish(new Error('The screenshot portal returned no image.'))
      try { finish(null, screenshotPath(uri.data)) } catch (error) { finish(error instanceof Error ? error : new Error('Invalid screenshot URI.')) }
    }
    bus.connection.on('error', failed)
    bus.connection.on('message', response)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    bus.invoke({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [`type='signal',sender='${PORTAL}',interface='org.freedesktop.portal.Request',member='Response'`] }, error => {
      if (settled) return
      if (error) return failed(error)
      bus.invoke({ destination: PORTAL, path: '/org/freedesktop/portal/desktop', interface: 'org.freedesktop.portal.Screenshot', member: 'Screenshot', signature: 'sa{sv}', body: ['', [['handle_token', ['s', token]], ['interactive', ['b', true]]]] }, (error, path) => {
        requestPath = path || requestPath
        if (settled) return
        if (error) failed(error)
      })
    })
  })
}
