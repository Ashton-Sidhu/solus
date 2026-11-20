// MCP Apps bridge, following T3 Code's host.ts (MIT, apps/mobile/UPSTREAM.md).
import { z } from 'zod'
import {
  MCP_APP_MAX_DATA_BYTES,
  MCP_APP_MAX_MODEL_CONTEXT_CHARS,
  MCP_APP_PROTOCOL_VERSION,
  type McpAppCancelReason,
  type McpAppLiveDocument,
  type McpAppPermission,
  type McpAppSnapshot,
  type McpAppToolInfo,
} from '@solus/contracts/mcp-apps'
import { MCP_APP_DISPLAY_MODES, MCP_APP_MAX_HEIGHT, type McpAppDisplayMode, type McpAppHostContext } from './mcp-app-context'
import { mcpAppGrantedPermissions } from './mcp-app-permissions'

/** What a client gives the bridge: its frame, its host calls, and its own approval prompt. */
export interface McpAppHostOptions {
  /**
   * The app's document. A saved app also holds its call's data. A live
   * document has none: the bridge then follows the call (`followCall`) until
   * it gets the result (`toolResult`).
   */
  snapshot: McpAppSnapshot | McpAppLiveDocument
  /** The app's name in the client's debug output. */
  title: string
  context(): McpAppHostContext
  /** The features the person granted this frame. */
  permissions(): readonly McpAppPermission[]
  post(json: string): void
  toolInfo(name: string): Promise<McpAppToolInfo>
  callTool(name: string, argumentsJson: string, approved: boolean): Promise<string>
  readResource(uri: string): Promise<string>
  /** `detail` is tool arguments as JSON (`arguments`) or text for a person to read (`text`). */
  confirm(title: string, detail: string, format: McpAppConfirmFormat): Promise<boolean>
  sendMessage(text: string): Promise<void>
  /** Replaces the app's context for the agent; empty text clears it. */
  updateModelContext(text: string): Promise<void>
  openLink(url: string): Promise<void>
  /** Puts the frame in a mode the bridge granted (`mcpAppGrantedDisplayMode`); answers the mode that results. */
  displayMode(mode: McpAppDisplayMode): McpAppDisplayMode
  /** The modes the app declared at initialize; null when it declared none. The person's controls follow them (`mcpAppOffersDisplayMode`). */
  declaredDisplayModes?(modes: readonly McpAppDisplayMode[] | null): void
  resize(height: number): void
  /**
   * Removes the frame. The bridge calls it after the app had its teardown;
   * with a reason when the call of a live card gave no result.
   */
  close(cancelled?: McpAppCancelReason): void
  /** The timers of a live card. Tests give a fake one. */
  clock?: McpAppClock
}

export type McpAppConfirmFormat = 'arguments' | 'text'

export interface McpAppClock {
  now(): number
  /** Runs `run` after `ms`; the answer cancels it. */
  schedule(run: () => void, ms: number): () => void
}

/** A tool call as the transcript shows it now, for a live app card. */
export interface McpAppLiveCall {
  /** The input text: whole, or the part streamed so far. */
  input: string
  /** Null while the call runs; `completed` once its result landed. */
  end: null | 'completed' | McpAppCancelReason
}

export type McpAppHost = ReturnType<typeof createMcpAppHost>

const MAX_PENDING_REQUESTS = 16
const MIN_HEIGHT = 80
/** How long a closing frame waits for the app to save its state. */
const TEARDOWN_TIMEOUT_MS = 1500
/** App log messages go to the client's debug output, bounded. */
const MAX_LOG_CHARS = 2000
const MAX_LOG_MESSAGES = 100
/** A live card gets at most ten partial inputs a second. */
export const MCP_APP_PARTIAL_INPUT_INTERVAL_MS = 100
/** After a call ended, how long a live card waits for its saved app. The host saves it before the result, so this is a wide margin. */
export const MCP_APP_CAPTURE_WAIT_MS = 15_000
const CALL_NOT_ENDED = 'The tool call has not ended.'
const systemClock: McpAppClock = {
  now: () => Date.now(),
  schedule: (run, ms) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
}

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
const displayModeSchema = z.object({ mode: z.enum(MCP_APP_DISPLAY_MODES) })
/** The modes an app declares in `ui/initialize`; a mode Solus does not know is left out. */
const initializeSchema = z.object({
  appCapabilities: z.object({ availableDisplayModes: z.array(z.string().max(32)).max(16).optional() }).optional(),
}).catch({})
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

/**
 * The mode an app's `ui/request-display-mode` results in (MCP Apps
 * 2026-01-26, "Display Modes"): the current mode when the client cannot give
 * the mode now, or when the app did not declare it. An app that declared no
 * modes keeps `inline` and `fullscreen`, as before, but gets no `pip`.
 */
export function mcpAppGrantedDisplayMode(
  requested: McpAppDisplayMode,
  host: Pick<McpAppHostContext, 'displayMode' | 'availableDisplayModes'>,
  declared: readonly McpAppDisplayMode[] | null,
): McpAppDisplayMode {
  if (!host.availableDisplayModes.includes(requested)) return host.displayMode
  if (declared ? !declared.includes(requested) : requested === 'pip') return host.displayMode
  return requested
}

/**
 * Whether the person's control may put the frame in `mode`. The client must
 * not give a mode that the app's declared list leaves out; the way back to
 * `inline` is always there.
 */
export function mcpAppOffersDisplayMode(
  mode: McpAppDisplayMode,
  availableDisplayModes: readonly McpAppDisplayMode[],
  declared: readonly McpAppDisplayMode[] | null,
): boolean {
  return mode === 'inline' || (availableDisplayModes.includes(mode) && (!declared || declared.includes(mode)))
}

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

/**
 * A frame has one bridge. A disposed bridge posts nothing and acts on nothing.
 * The app gets the call's data in the order of the specification: partial
 * inputs, the input once, then the result or the cancel. A notification waits
 * until the app is ready; the app then gets the newest state.
 */
export function createMcpAppHost(options: McpAppHostOptions) {
  const clock = options.clock ?? systemClock
  let disposed = false
  let initialized = false
  let closing = false
  let pending = 0
  let modelContext = ''
  let declaredModes: McpAppDisplayMode[] | null = null
  let logged = 0
  let nextRequestId = 0
  const answers = new Map<string, () => void>()
  const saved = 'toolResultJson' in options.snapshot ? options.snapshot : null
  let inputJson: string | null = saved?.toolInputJson ?? null
  let resultJson: string | null = saved?.toolResultJson ?? null
  let cancelled: McpAppCancelReason | null = null
  /** The newest healed partial input, and the last one the app got. */
  let partialJson: string | null = null
  let sentPartialJson: string | null = null
  let partialSentAt = Number.NEGATIVE_INFINITY
  let cancelPartial: (() => void) | null = null
  let cancelCaptureWait: (() => void) | null = null

  const post = (json: string) => {
    if (!disposed) options.post(json)
  }
  // Results are JSON the host already holds as text; they are spliced in, not parsed again.
  const notify = (method: string, paramsJson: string) => post(`{"jsonrpc":"2.0","method":${JSON.stringify(method)},"params":${paramsJson}}`)
  const reply = (id: string | number, resultJson: string) => post(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${resultJson}}`)
  const fail = (id: string | number, message: string) => post(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }))
  /** A live card's host calls name a saved app, which exists only once the call ended. */
  const requireResult = () => {
    if (resultJson === null) throw new Error(CALL_NOT_ENDED)
  }
  const clearTimers = () => {
    cancelPartial?.()
    cancelCaptureWait?.()
    cancelPartial = cancelCaptureWait = null
  }

  const sendPartial = () => {
    cancelPartial = null
    if (!initialized || inputJson !== null || cancelled || partialJson === null || partialJson === sentPartialJson) return
    sentPartialJson = partialJson
    partialSentAt = clock.now()
    notify('ui/notifications/tool-input-partial', `{"arguments":${partialJson}}`)
  }
  const schedulePartial = () => {
    if (cancelPartial) return
    const wait = partialSentAt + MCP_APP_PARTIAL_INPUT_INTERVAL_MS - clock.now()
    if (wait <= 0) sendPartial()
    else cancelPartial = clock.schedule(sendPartial, wait)
  }
  const sendInput = () => notify('ui/notifications/tool-input', `{"arguments":${inputJson}}`)
  const sendResult = () => notify('ui/notifications/tool-result', resultJson ?? '{}')

  function takeInput(json: string): void {
    if (inputJson !== null) return
    inputJson = json
    cancelPartial?.()
    cancelPartial = null
    if (initialized) sendInput()
  }

  /** The call gave no result: the app hears why, has its teardown, and the card goes. */
  function cancel(reason: McpAppCancelReason): void {
    if (cancelled || resultJson !== null) return
    cancelled = reason
    clearTimers()
    if (initialized) notify('ui/notifications/tool-cancelled', JSON.stringify({ reason }))
    void close()
  }

  /** Asks the person; a bridge closed while they decide does nothing. */
  const approve = async (title: string, detail: string, format: McpAppConfirmFormat = 'text') => {
    if (!(await options.confirm(title, detail, format)) || disposed) throw new DeclinedError()
  }

  /** The modes the app declares at initialize; the bridge grants only those, and the client offers only those. */
  function takeDeclaredModes({ appCapabilities }: z.infer<typeof initializeSchema>): void {
    const declared = appCapabilities?.availableDisplayModes
    declaredModes = declared ? MCP_APP_DISPLAY_MODES.filter((mode) => declared.includes(mode)) : null
    options.declaredDisplayModes?.(declaredModes)
  }

  async function answer({ method, params }: Envelope): Promise<string> {
    switch (method) {
      case 'ui/initialize':
        takeDeclaredModes(initializeSchema.parse(params))
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
        requireResult()
        const call = toolCallSchema.parse(params)
        const tool = await options.toolInfo(call.name)
        if (!tool.callable) throw new Error(tool.refusal ?? 'This app cannot call that tool.')
        const argumentsJson = JSON.stringify(call.arguments)
        if (!tool.readOnly) await approve(`Allow ${tool.title}?`, JSON.stringify(call.arguments, null, 2), 'arguments')
        else if (disposed) throw new DeclinedError()
        // The host answers JSON text; parsing it here keeps a bad answer out of the reply.
        return JSON.stringify(JSON.parse(await options.callTool(call.name, argumentsJson, !tool.readOnly)))
      }
      case 'resources/read': {
        requireResult()
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
        requireResult()
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
        const context = options.context()
        const granted = mcpAppGrantedDisplayMode(mode, context, declaredModes)
        return JSON.stringify({ mode: granted === context.displayMode ? granted : options.displayMode(granted) })
      }
      default:
        throw new Error(`Unsupported app request: ${method}`)
    }
  }

  function onNotification({ method, params }: Envelope): void {
    if (method === 'ui/notifications/initialized') {
      if (initialized) return
      initialized = true
      if (inputJson !== null) sendInput()
      else sendPartial()
      if (resultJson !== null) sendResult()
      else if (cancelled) notify('ui/notifications/tool-cancelled', JSON.stringify({ reason: cancelled }))
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
    if (!disposed) options.close(cancelled ?? undefined)
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
    /**
     * A live card follows its call: each change of the transcript's tool call
     * comes here. A streamed input reaches the app healed, ten times a second
     * at most; a whole input once. A call that ended with no saved app within
     * a short time is cancelled as `failed`.
     */
    followCall(call: McpAppLiveCall): void {
      if (disposed || saved || resultJson !== null || cancelled) return
      if (inputJson === null) {
        const whole = wholeArguments(call.input)
        if (whole !== null) takeInput(whole)
        else if (call.end === null) {
          const healed = jsonObjectSchema.safeParse(healPartialJson(call.input))
          if (healed.success) {
            partialJson = JSON.stringify(healed.data)
            if (initialized) schedulePartial()
          }
        }
      }
      if (call.end === 'completed') cancelCaptureWait ??= clock.schedule(() => cancel('failed'), MCP_APP_CAPTURE_WAIT_MS)
      else if (call.end) cancel(call.end)
    },
    /** The saved app of a live card's call arrived: the app gets the input if it had none, then the result. */
    toolResult(call: Pick<McpAppSnapshot, 'toolInputJson' | 'toolResultJson'>): void {
      if (disposed || resultJson !== null || cancelled) return
      clearTimers()
      takeInput(call.toolInputJson)
      resultJson = call.toolResultJson
      if (initialized) sendResult()
    },
    dispose(): void {
      disposed = true
      clearTimers()
      for (const answer of answers.values()) answer()
    },
  }
}

type JsonValue = z.infer<ReturnType<typeof z.json>>
/** Tool arguments are a JSON object. */
const jsonObjectSchema = z.record(z.string(), z.json())

/** The arguments as JSON text when the input is a whole JSON object, else null. */
function wholeArguments(input: string): string | null {
  try {
    const value = jsonObjectSchema.safeParse(JSON.parse(input))
    return value.success ? JSON.stringify(value.data) : null
  } catch {
    return null
  }
}

type JsonFrame = { kind: 'object'; expects: 'key' | 'colon' | 'value' | 'comma' } | { kind: 'array'; expects: 'value' | 'comma' }
const WHOLE_ATOM = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/

/** A cut JSON text as it is read: what is kept, and up to where it closes into JSON. */
interface HealState {
  readonly text: string
  index: number
  out: string
  /** The end of the last whole value or open bracket: cut there, the text closes into JSON. */
  safe: number
  readonly frames: JsonFrame[]
  /** The rest of the text can still grow, so it is dropped. */
  isCut: boolean
}

/**
 * The value of a JSON text that was cut while it streamed. A cut string is
 * closed (a cut escape is dropped first), a key with no value and a cut number
 * or literal are dropped, and each open array and object is closed. Undefined
 * when nothing whole is left or the text is not JSON.
 */
export function healPartialJson(text: string): JsonValue | undefined {
  const state: HealState = { text, index: 0, out: '', safe: 0, frames: [], isCut: false }
  while (!state.isCut && state.index < text.length) readToken(state)
  if (state.safe === 0) return undefined
  const closers = state.frames.map((frame) => (frame.kind === 'object' ? '}' : ']')).reverse().join('')
  try {
    return JSON.parse(state.out.slice(0, state.safe) + closers)
  } catch {
    return undefined
  }
}

function readToken(state: HealState): void {
  const char = state.text[state.index]
  if (char === ' ' || char === '\n' || char === '\r' || char === '\t') state.index++
  else if (char === '"') readString(state)
  else if (char === '{' || char === '[') {
    state.out += char
    state.frames.push(char === '{' ? { kind: 'object', expects: 'key' } : { kind: 'array', expects: 'value' })
    state.safe = state.out.length
    state.index++
  } else if (char === '}' || char === ']') {
    state.out += char
    state.frames.pop()
    valueEnded(state)
    state.index++
  } else if (char === ':' || char === ',') {
    state.out += char
    const top = state.frames.at(-1)
    if (top) top.expects = char === ':' ? 'value' : top.kind === 'object' ? 'key' : 'value'
    state.index++
  } else readAtom(state)
}

function valueEnded(state: HealState): void {
  const top = state.frames.at(-1)
  if (top) top.expects = 'comma'
  state.safe = state.out.length
}

/** A whole string is kept; a cut value is closed, and a cut key is dropped. */
function readString(state: HealState): void {
  const top = state.frames.at(-1)
  const isKey = top?.kind === 'object' && top.expects === 'key'
  const end = stringEnd(state.text, state.index)
  if (end < 0) {
    state.isCut = true
    if (isKey) return
    state.out += closedString(state.text.slice(state.index))
    valueEnded(state)
    return
  }
  state.out += state.text.slice(state.index, end)
  state.index = end
  if (isKey) top.expects = 'colon'
  else valueEnded(state)
}

/** A number or a literal. The last one may still grow: only a whole one is kept. */
function readAtom(state: HealState): void {
  const atom = /^[^\s,:[\]{}"]+/.exec(state.text.slice(state.index))?.[0] ?? state.text[state.index]
  state.index += atom.length
  if (state.index >= state.text.length && !WHOLE_ATOM.test(atom)) {
    state.isCut = true
    return
  }
  state.out += atom
  valueEnded(state)
}

/** The index after the closing quote of the string at `start`, or -1 when it is cut. */
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === '"') return index + 1
  }
  return -1
}

/** A cut string, closed: a cut escape at its end is dropped. */
function closedString(cut: string): string {
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0
  const text = (trailing % 2 ? cut.slice(0, -1) : cut).replace(/\\u[0-9a-fA-F]{0,3}$/, '')
  return `${text}"`
}
