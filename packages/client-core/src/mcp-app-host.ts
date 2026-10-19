// MCP Apps bridge, following T3 Code's host.ts (MIT, apps/mobile/UPSTREAM.md).
import { z } from 'zod'
import { MCP_APP_MAX_DATA_BYTES, MCP_APP_PROTOCOL_VERSION, type McpAppSnapshot, type McpAppToolInfo } from '@solus/contracts/mcp-apps'

type DisplayMode = 'inline' | 'fullscreen'

export interface McpAppHostContext {
  theme: 'light' | 'dark'
  displayMode: DisplayMode
  availableDisplayModes: DisplayMode[]
  platform: 'web' | 'mobile'
  styles: {
    variables: {
      '--color-background-primary': string
      '--color-background-secondary': string
      '--color-text-primary': string
      '--color-text-secondary': string
      '--color-border-primary': string
      '--font-sans': string
    }
  }
}

/** What a client gives the bridge: its frame, its host calls, and its own approval prompt. */
export interface McpAppHostOptions {
  snapshot: McpAppSnapshot
  context(): McpAppHostContext
  post(json: string): void
  toolInfo(name: string): Promise<McpAppToolInfo>
  callTool(name: string, argumentsJson: string, approved: boolean): Promise<string>
  readResource(uri: string): Promise<string>
  confirm(title: string, detail: string): Promise<boolean>
  sendMessage(text: string): Promise<void>
  openLink(url: string): Promise<void>
  displayMode(mode: DisplayMode): void
  resize(height: number): void
  close(): void
}

export type McpAppHost = ReturnType<typeof createMcpAppHost>

const MAX_PENDING_REQUESTS = 16
const MIN_HEIGHT = 80
const MAX_HEIGHT = 2000

const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(256), z.number()]).optional(),
  method: z.string().max(256),
  params: z.unknown().optional(),
})
type Envelope = z.infer<typeof envelopeSchema>

const toolCallSchema = z.object({ name: z.string().min(1).max(256), arguments: z.record(z.string(), z.json()).default({}) })
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string().max(64_000) })
const messageSchema = z.object({ role: z.literal('user'), content: z.union([textBlockSchema, z.array(textBlockSchema).min(1).max(32)]) })
const resourceReadSchema = z.object({ uri: z.string().min(1).max(4096) })
const openLinkSchema = z.object({ url: z.url().refine((url) => /^https?:\/\//i.test(url)) })
const displayModeSchema = z.object({ mode: z.enum(['inline', 'fullscreen']) })
const sizeSchema = z.object({ height: z.number().finite().positive() })

class DeclinedError extends Error {
  constructor() {
    super('Declined by the user.')
  }
}

/** A frame has one bridge. A disposed bridge posts nothing and acts on nothing. */
export function createMcpAppHost(options: McpAppHostOptions) {
  let disposed = false
  let initialized = false
  let pending = 0

  const post = (json: string) => {
    if (!disposed) options.post(json)
  }
  // Results are JSON the host already holds as text; they are spliced in, not parsed again.
  const notify = (method: string, paramsJson: string) => post(`{"jsonrpc":"2.0","method":${JSON.stringify(method)},"params":${paramsJson}}`)
  const reply = (id: string | number, resultJson: string) => post(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${resultJson}}`)
  const fail = (id: string | number, message: string) => post(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }))

  /** Asks the person; a bridge closed while they decide does nothing. */
  const approve = async (title: string, detail: string) => {
    if (!(await options.confirm(title, detail)) || disposed) throw new DeclinedError()
  }

  async function answer({ method, params }: Envelope): Promise<string> {
    switch (method) {
      case 'ui/initialize':
        return JSON.stringify({
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: 'solus', version: '1.0.0' },
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, message: { text: {} }, sandbox: { csp: options.snapshot.csp } },
          hostContext: options.context(),
        })
      case 'ping':
        return '{}'
      case 'tools/call': {
        const call = toolCallSchema.parse(params)
        const tool = await options.toolInfo(call.name)
        if (!tool.callable) throw new Error('This app cannot call that tool.')
        const argumentsJson = JSON.stringify(call.arguments)
        if (!tool.readOnly) await approve(`Allow ${tool.title}?`, argumentsJson)
        else if (disposed) throw new DeclinedError()
        // The host answers JSON text; parsing it here keeps a bad answer out of the reply.
        return JSON.stringify(JSON.parse(await options.callTool(call.name, argumentsJson, !tool.readOnly)))
      }
      case 'resources/read': {
        const { uri } = resourceReadSchema.parse(params)
        return JSON.stringify(JSON.parse(await options.readResource(uri)))
      }
      case 'ui/message': {
        const { content } = messageSchema.parse(params)
        const text = (Array.isArray(content) ? content : [content]).map((block) => block.text).join('\n').trim()
        if (!text) throw new Error('The message is empty.')
        await approve('Send this message?', text)
        await options.sendMessage(text)
        return '{}'
      }
      case 'ui/open-link': {
        const { url } = openLinkSchema.parse(params)
        await approve('Open this link?', url)
        await options.openLink(url)
        return '{}'
      }
      case 'ui/request-display-mode': {
        const { mode } = displayModeSchema.parse(params)
        options.displayMode(mode)
        return JSON.stringify({ mode })
      }
      default:
        throw new Error(`Unsupported app request: ${method}`)
    }
  }

  function onNotification({ method, params }: Envelope): void {
    if (method === 'ui/notifications/initialized') {
      if (initialized) return
      initialized = true
      notify('ui/notifications/tool-input', JSON.stringify({ arguments: JSON.parse(options.snapshot.toolInputJson) }))
      notify('ui/notifications/tool-result', options.snapshot.toolResultJson)
    } else if (method === 'ui/notifications/size-changed') {
      const size = sizeSchema.safeParse(params)
      if (size.success) options.resize(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(size.data.height))))
    } else if (method === 'ui/notifications/request-teardown') {
      options.close()
    }
  }

  return {
    /** One message from the app frame, as JSON text. Malformed messages are ignored. */
    async receive(json: string): Promise<void> {
      if (disposed || json.length > MCP_APP_MAX_DATA_BYTES) return
      let envelope: Envelope
      try {
        envelope = envelopeSchema.parse(JSON.parse(json))
      } catch {
        return
      }
      const { id } = envelope
      if (id === undefined) return onNotification(envelope)
      if (pending >= MAX_PENDING_REQUESTS) return fail(id, 'Too many app requests.')
      pending++
      try {
        reply(id, await answer(envelope))
      } catch (error) {
        fail(id, error instanceof Error ? error.message : 'The app request failed.')
      } finally {
        pending--
      }
    },
    /** Sends the current theme and display mode once the app is ready for them. */
    updateContext(): void {
      if (initialized) notify('ui/notifications/host-context-changed', JSON.stringify(options.context()))
    },
    dispose(): void {
      disposed = true
    },
  }
}
