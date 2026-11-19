// MCP Apps bridge, following T3 Code's host.ts (MIT, apps/mobile/UPSTREAM.md).
import { z } from 'zod'
import {
  MCP_APP_MAX_DATA_BYTES,
  MCP_APP_MAX_MODEL_CONTEXT_CHARS,
  MCP_APP_PROTOCOL_VERSION,
  type McpAppPermission,
  type McpAppSnapshot,
  type McpAppToolInfo,
} from '@solus/contracts/mcp-apps'
import { MCP_APP_MAX_HEIGHT, type McpAppDisplayMode, type McpAppHostContext } from './mcp-app-context'
import { mcpAppGrantedPermissions } from './mcp-app-permissions'

/** What a client gives the bridge: its frame, its host calls, and its own approval prompt. */
export interface McpAppHostOptions {
  snapshot: McpAppSnapshot
  /** The app's name in the client's debug output. */
  title: string
  context(): McpAppHostContext
  /** The features the person granted this frame. */
  permissions(): readonly McpAppPermission[]
  post(json: string): void
  toolInfo(name: string): Promise<McpAppToolInfo>
  callTool(name: string, argumentsJson: string, approved: boolean): Promise<string>
  readResource(uri: string): Promise<string>
  confirm(title: string, detail: string): Promise<boolean>
  sendMessage(text: string): Promise<void>
  /** Replaces the app's context for the agent; empty text clears it. */
  updateModelContext(text: string): Promise<void>
  openLink(url: string): Promise<void>
  displayMode(mode: McpAppDisplayMode): void
  resize(height: number): void
  /** Removes the frame. The bridge calls it after the app had its teardown. */
  close(): void
}

export type McpAppHost = ReturnType<typeof createMcpAppHost>

const MAX_PENDING_REQUESTS = 16
const MIN_HEIGHT = 80
/** How long a closing frame waits for the app to save its state. */
const TEARDOWN_TIMEOUT_MS = 1500
/** App log messages go to the client's debug output, bounded. */
const MAX_LOG_CHARS = 2000
const MAX_LOG_MESSAGES = 100

const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(256), z.number()]).optional(),
  method: z.string().max(256),
  params: z.unknown().optional(),
})
type Envelope = z.infer<typeof envelopeSchema>
/** The app's answer to a request the host sent. */
const responseSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.string().max(256), result: z.unknown().optional(), error: z.unknown().optional() })

const toolCallSchema = z.object({ name: z.string().min(1).max(256), arguments: z.record(z.string(), z.json()).default({}) })
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string().max(64_000) })
const messageSchema = z.object({ role: z.literal('user'), content: z.union([textBlockSchema, z.array(textBlockSchema).min(1).max(32)]) })
const resourceReadSchema = z.object({ uri: z.string().min(1).max(4096) })
const openLinkSchema = z.object({ url: z.url().refine((url) => /^https?:\/\//i.test(url)) })
const displayModeSchema = z.object({ mode: z.enum(['inline', 'fullscreen']) })
const sizeSchema = z.object({ height: z.number().finite().positive() })
const modelContextSchema = z.object({
  content: z.array(z.object({ type: z.string().max(64), text: z.string().optional() })).max(32).optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
})
/** An app log line; data that is not text is shown as JSON. */
const logSchema = z.object({
  level: z.string().max(32),
  logger: z.string().max(256).optional(),
  data: z.union([z.string(), z.json().transform((value) => JSON.stringify(value))]).default(''),
})

/** The text the agent gets from one `ui/update-model-context`: text blocks, then structured content as JSON. */
function modelContextText({ content = [], structuredContent }: z.infer<typeof modelContextSchema>): string {
  if (content.some((block) => block.type !== 'text')) throw new Error('Only text context is supported.')
  const text = [...content.map((block) => block.text ?? ''), structuredContent ? JSON.stringify(structuredContent) : '']
    .filter(Boolean).join('\n\n').trim()
  if (text.length > MCP_APP_MAX_MODEL_CONTEXT_CHARS) throw new Error('This context is too large for the agent.')
  return text
}

class DeclinedError extends Error {
  constructor() {
    super('Declined by the user.')
  }
}

/** A frame has one bridge. A disposed bridge posts nothing and acts on nothing. */
export function createMcpAppHost(options: McpAppHostOptions) {
  let disposed = false
  let initialized = false
  let closing = false
  let pending = 0
  let modelContext = ''
  let logged = 0
  let nextRequestId = 0
  const answers = new Map<string, () => void>()

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
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            logging: {},
            message: { text: {} },
            updateModelContext: { text: {}, structuredContent: {} },
            sandbox: { csp: options.snapshot.csp, permissions: mcpAppGrantedPermissions(options.permissions()) },
          },
          hostContext: options.context(),
        })
      case 'ping':
        return '{}'
      case 'tools/call': {
        const call = toolCallSchema.parse(params)
        const tool = await options.toolInfo(call.name)
        if (!tool.callable) throw new Error(tool.refusal ?? 'This app cannot call that tool.')
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
      case 'ui/update-model-context': {
        // Each update replaces the last; the same text again changes nothing.
        const text = modelContextText(modelContextSchema.parse(params))
        if (text === modelContext) return '{}'
        await options.updateModelContext(text)
        modelContext = text
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
      if (size.success) options.resize(Math.min(MCP_APP_MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(size.data.height))))
    } else if (method === 'ui/notifications/request-teardown') {
      void close()
    } else if (method === 'notifications/message') {
      const entry = logSchema.safeParse(params)
      if (entry.success) log(entry.data)
    }
  }

  function log({ level, logger, data }: z.infer<typeof logSchema>): void {
    if (logged > MAX_LOG_MESSAGES) return
    logged++
    const line = logged > MAX_LOG_MESSAGES ? 'Further log messages of this app are dropped.' : `${logger ? `${logger}: ` : ''}${data}`
    console.debug(`[MCP App ${options.title}] ${level}`, line.slice(0, MAX_LOG_CHARS))
  }

  /**
   * Gives the app its teardown, waits a short time for its answer, then removes
   * the frame. The specification forbids a request before the app is ready.
   */
  async function close(): Promise<void> {
    if (closing || disposed) return
    closing = true
    if (initialized) {
      const id = `solus-${++nextRequestId}`
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS)
        answers.set(id, () => {
          clearTimeout(timer)
          resolve()
        })
        post(JSON.stringify({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: {} }))
      })
      answers.delete(id)
    }
    if (!disposed) options.close()
  }

  return {
    /** One message from the app frame, as JSON text. Malformed messages are ignored. */
    async receive(json: string): Promise<void> {
      if (disposed || json.length > MCP_APP_MAX_DATA_BYTES) return
      let message: unknown
      let envelope: Envelope
      try {
        message = JSON.parse(json)
        envelope = envelopeSchema.parse(message)
      } catch {
        const response = responseSchema.safeParse(message)
        if (response.success) answers.get(response.data.id)?.()
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
    /** Sends the current theme, display mode, and size once the app is ready for them. */
    updateContext(): void {
      if (initialized) notify('ui/notifications/host-context-changed', JSON.stringify(options.context()))
    },
    /** Closes the app the way the person asked: the app gets its teardown first. */
    close,
    dispose(): void {
      disposed = true
      for (const answer of answers.values()) answer()
    },
  }
}
