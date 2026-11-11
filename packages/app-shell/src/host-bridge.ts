/**
 * The frame's side of the MCP Apps protocol (docs/plans/apps.md §2 decision 2).
 *
 * The host is `createMcpAppHost` in `@solus/client-core`: it answers
 * `ui/initialize` with the theme, asks the person before a write runs, and
 * sends `ui/notifications/host-context-changed` when the theme changes. The
 * frame talks to its parent window only; a message from anywhere else is
 * dropped. Every message is parsed at this boundary.
 */

import { z } from 'zod'

export type HostTheme = 'light' | 'dark'

/** A JSON value, which is all a tool takes and all it answers. */
export type ToolValue = string | number | boolean | null | ToolValue[] | { [key: string]: ToolValue }
export type ToolArguments = { [key: string]: ToolValue }

const toolValueSchema: z.ZodType<ToolValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(toolValueSchema), z.record(z.string(), toolValueSchema)]))

const themeSchema = z.enum(['light', 'dark'])
const hostContextSchema = z.object({ theme: themeSchema.optional() })
const initializeResultSchema = z.object({ hostContext: hostContextSchema.optional() })

/** A `tools/call` result as the host answers it: the MCP `CallToolResult`. */
const toolCallResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: toolValueSchema.optional(),
  isError: z.boolean().optional(),
})
export type ToolCallResult = z.infer<typeof toolCallResultSchema>

const hostValueSchema = z.object({ value: toolValueSchema })

const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: toolValueSchema.optional(),
  result: toolValueSchema.optional(),
  error: z.object({ message: z.string().optional() }).optional(),
})

interface PendingRequest {
  resolve: (result: ToolValue | undefined) => void
  reject: (error: Error) => void
}

const REQUEST_TIMEOUT_MS = 120_000

export class HostBridge {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly themeListeners = new Set<(theme: HostTheme) => void>()
  theme: HostTheme = 'light'

  constructor() {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return
      const parsed = envelopeSchema.safeParse(event.data)
      if (!parsed.success) return
      const message = parsed.data
      if (message.id !== undefined && message.method === undefined) this.settle(message.id, message.result, message.error?.message)
      else if (message.method === 'ui/notifications/host-context-changed') this.applyContext(message.params)
    })
  }

  /** Tells the host the frame is ready and reads the theme it starts with. */
  async initialize(): Promise<void> {
    const answer = initializeResultSchema.safeParse(await this.request('ui/initialize', {}))
    if (answer.success) this.applyContext(answer.data.hostContext)
    this.notify('ui/notifications/initialized', {})
  }

  onTheme(listener: (theme: HostTheme) => void): () => void {
    this.themeListeners.add(listener)
    return () => this.themeListeners.delete(listener)
  }

  async callTool(name: string, args: ToolArguments): Promise<ToolValue> {
    const result = toolCallResultSchema.safeParse(await this.request('tools/call', { name, arguments: args }))
    return unwrapToolResult(result.success ? result.data : null)
  }

  /**
   * A call the host itself answers: the app's storage, or one of its host
   * functions. The host wraps the answer as `{ value }`, because a tool
   * result's structured content is always an object.
   */
  async callValue(name: string, args: ToolArguments): Promise<ToolValue> {
    const answer = hostValueSchema.safeParse(await this.callTool(name, args))
    return answer.success ? answer.data.value : null
  }

  reportHeight(height: number): void {
    this.notify('ui/notifications/size-changed', { height })
  }

  private request(method: string, params: ToolArguments): Promise<ToolValue | undefined> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The host did not answer ${method}.`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
    })
  }

  private notify(method: string, params: ToolArguments): void {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*')
  }

  private settle(id: string | number, result: ToolValue | undefined, errorMessage: string | undefined): void {
    const waiting = this.pending.get(Number(id))
    if (!waiting) return
    this.pending.delete(Number(id))
    if (errorMessage !== undefined) waiting.reject(new Error(errorMessage || 'The host refused the request.'))
    else waiting.resolve(result)
  }

  private applyContext(context: ToolValue | undefined): void {
    const parsed = hostContextSchema.safeParse(context)
    const theme = parsed.success ? parsed.data.theme : undefined
    if (!theme) return
    this.theme = theme
    for (const listener of this.themeListeners) listener(theme)
  }
}

/** The value a component sees: the structured content when the server sent
 *  one, else the text blocks parsed as JSON, else the text itself. */
export function unwrapToolResult(result: ToolCallResult | null): ToolValue {
  if (!result) return null
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  if (result.isError) throw new Error(text || 'The tool call failed.')
  if (result.structuredContent !== undefined) return result.structuredContent
  if (!text) return null
  try {
    const parsed = toolValueSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : text
  } catch {
    return text
  }
}
