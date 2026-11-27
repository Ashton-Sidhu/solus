import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { AcpToolCall } from './acp-protocol'
import { boundToolOutput, presentAcpTool, type AcpTurnNormalizer } from './acp-turn-normalizer'
import { managedPath } from './antigravity-turn-outcome'

const idPattern = /^[\w-]+$/
const descriptor = z.object({ conversationId: z.string().regex(idPattern) })
const message = z.object({
  sender: z.string(),
  sourceMetadata: z.object({ tool: z.object({ toolCall: z.object({ id: z.string(), name: z.literal('invoke_subagent') }) }) }),
})
const step = z.object({
  step_index: z.number().int().nonnegative(),
  type: z.string(),
  status: z.string().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
  tool_calls: z.array(z.object({ name: z.string(), id: z.string().optional(), args: z.json().optional() })).optional(),
})
type Step = z.infer<typeof step>
type JsonValue = z.core.util.JSONType
const signatureFields = z.object({ command: z.string().optional(), file_path: z.string().optional() })
const inputFields = z.looseObject({ Path: z.string().optional(), DirectoryPath: z.string().optional() })
const BOUNDARIES = new Set(['PLANNER_RESPONSE', 'SYSTEM_MESSAGE', 'USER_INPUT', 'ERROR_MESSAGE'])
const READS = new Set(['read_file', 'view_file', 'view_file_outline', 'view_code_item', 'client_view_file', 'list_dir'])
const EDITS = new Set(['edit_file', 'write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'])
const COMMANDS = new Set(['run_command', 'bash', 'shell'])
const MAX_FILE_BYTES = 512 * 1024
const FINAL_POLLS_MS = [500, 1_000, 2_000, 4_000, 5_000, 6_000, 6_000, 5_500]

function decodeJson(text: string): JsonValue | undefined {
  try {
    return z.json().parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

const argString = z.string()
const namedArgs = z.record(z.string(), z.json())
const resultStatus = new Map<string, 'failed' | 'completed'>([
  ['ERROR', 'failed'], ['FAILED', 'failed'], ['DONE', 'completed'], ['COMPLETED', 'completed'],
] as const)

function argumentValue(value: JsonValue | undefined): JsonValue | undefined {
  const text = argString.safeParse(value).data
  if (text === undefined) return value
  const decoded = decodeJson(text)
  return decoded === undefined ? value : decoded
}

/** agy records each argument as JSON text in the native transcript. */
function decodeArgs(args: JsonValue | undefined): JsonValue | undefined {
  const fields = namedArgs.safeParse(args).data
  return fields
    ? Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, argumentValue(value) ?? null]))
    : argumentValue(args)
}

function kindOf(name: string): AcpToolCall['kind'] {
  if (COMMANDS.has(name)) return 'execute'
  if (READS.has(name)) return 'read'
  if (EDITS.has(name)) return 'edit'
  return 'other'
}

function toolCall(childId: string, planner: Step, call: NonNullable<Step['tool_calls']>[number], index: number, result?: Step): AcpToolCall {
  const input = decodeArgs(call.args)
  const fields = inputFields.safeParse(input).data
  const path = fields?.Path ?? fields?.DirectoryPath
  const status = result?.status && resultStatus.get(result.status)
  return {
    toolCallId: `${childId}:transcript-${planner.step_index}-${index}`,
    title: call.name,
    kind: kindOf(call.name),
    rawInput: input,
    ...(path && { locations: [{ path }] }),
    ...(status && { status, rawOutput: boundToolOutput(result?.error ?? result?.content ?? '') }),
  }
}

function signature(call: AcpToolCall): string {
  const path = inputFields.safeParse(call.rawInput).data
  const location = call.locations ?? (path?.Path ? [{ path: path.Path }] : undefined)
  const { toolName, toolInput } = presentAcpTool({
    kind: call.kind, title: call.title ?? null, rawInput: call.rawInput, locations: location, diff: null,
  })
  const input = toolInput ? decodeJson(toolInput) : undefined
  const fields = signatureFields.safeParse(input).data
  return JSON.stringify([toolName.replace(/^Run(?:ning)? /, '').replace(/\?$/, ''), fields?.command ?? fields?.file_path ?? ''])
}

async function readFile(profile: string, segments: readonly string[], limit: number, tail: boolean): Promise<string> {
  const file = managedPath(profile, segments, 'file')
  if (!file || (!tail && file.info.size > limit)) return ''
  try {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.ino !== file.info.ino || info.dev !== file.info.dev) return ''
      const start = Math.max(0, info.size - limit)
      const bytes = Buffer.alloc(info.size - start)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start)
      const body = bytes.toString('utf8', 0, bytesRead)
      return start > 0 ? body.slice(body.indexOf('\n') + 1) : body
    } finally {
      await handle.close()
    }
  } catch {
    // agy can replace the file while updating a child transcript.
    return ''
  }
}

interface Child {
  parent: string
  calls: Map<string, { id: string; signature: string; providerId?: string; nativeId?: string }>
  seen: Set<string>
  pending: Map<string, AcpToolCall>
  report: string
  hasFinalReply: boolean
  source?: string
}

/** Reads the native child files used by agy 1.5. ACP still owns matching calls
 * it sends itself. The file supplies replies and calls missing from ACP. */
export class AntigravityChildTranscript {
  private readonly children = new Map<string, Child>()
  private readonly streamed = new Map<string, { signature?: string; toolId: string }>()
  private readonly parents = new Map<string, number>()

  constructor(private readonly storage: string, private readonly rootId: string) {}

  noteLaunch(toolCallId: string, childCount: number): void {
    this.parents.set(toolCallId, childCount)
  }

  parentOf(childId: string): string | undefined {
    return this.children.get(childId)?.parent
  }

  noteChild(childId: string, parent: string): void {
    if (!this.parents.has(parent) || this.children.has(childId)) return
    this.children.set(childId, { parent, calls: new Map(), seen: new Set(), pending: new Map(), report: '', hasFinalReply: false })
  }

  toolIdOf(childId: string, call: AcpToolCall): string {
    const known = this.streamed.get(call.toolCallId)
    if (known) return known.toolId
    const hasInput = !!call.kind || !!call.title || call.rawInput !== undefined
    const key = hasInput ? signature(call) : undefined
    const child = this.children.get(childId)
    const calls = child && [...child.calls.values()]
    const matched = calls?.find((candidate) => !candidate.nativeId && candidate.providerId === call.toolCallId)
      ?? (key === undefined ? undefined : calls?.find((candidate) => !candidate.nativeId && candidate.signature === key))
    if (!matched && !key) return call.toolCallId
    if (matched) matched.nativeId = call.toolCallId
    const toolId = matched?.id ?? call.toolCallId
    this.streamed.set(call.toolCallId, { signature: key, toolId })
    return toolId
  }

  async poll(normalizer: AcpTurnNormalizer): Promise<NormalizedEvent[]> {
    if (!this.parents.size || !idPattern.test(this.rootId)) return []
    await this.discover()
    const events: NormalizedEvent[] = []
    for (const [childId, child] of this.children) {
      const body = await readFile(this.storage, this.brain(childId, 'logs', 'transcript.jsonl'), MAX_FILE_BYTES, true)
      if (!body || body === child.source) continue
      child.source = body
      const steps = new Map<number, Step>()
      for (const line of body.split('\n')) {
        if (!line) continue
        const parsed = step.safeParse(decodeJson(line))
        if (parsed.success) steps.set(parsed.data.step_index, parsed.data)
      }
      this.project(childId, child, [...steps.values()].sort((a, b) => a.step_index - b.step_index), normalizer, events)
    }
    return events
  }

  async drain(normalizer: AcpTurnNormalizer, signal: AbortSignal, emit: (event: NormalizedEvent) => void): Promise<void> {
    if (!this.parents.size) return
    for (const event of await this.poll(normalizer)) emit(event)
    for (const wait of FINAL_POLLS_MS) {
      if (signal.aborted || this.repliesComplete()) break
      await delay(wait, undefined, { signal }).catch(() => {})
      if (signal.aborted) return
      for (const event of await this.poll(normalizer)) emit(event)
      if (!this.children.size) break
    }
    if (signal.aborted) return
    const reports = new Map<string, string[]>()
    for (const child of this.children.values()) {
      for (const [id, call] of child.pending) {
        for (const event of normalizer.projectToolCall({ ...call, toolCallId: id, status: 'failed' })) emit(event)
      }
      if (!child.report) continue
      const replies = reports.get(child.parent) ?? []
      if (!replies.includes(child.report)) replies.push(child.report)
      reports.set(child.parent, replies)
    }
    for (const [toolUseId, replies] of reports) {
      emit({ type: 'tool_result', toolUseId, isSubagentReport: true, content: replies.join('\n\n') })
    }
  }

  private project(childId: string, child: Child, steps: Step[], normalizer: AcpTurnNormalizer, events: NormalizedEvent[]): void {
    const parentToolUseId = child.parent
    for (let index = 0; index < steps.length; index++) {
      const planner = steps[index]!
      if (planner.type !== 'PLANNER_RESPONSE') continue
      const key = String(planner.step_index)
      const reply = planner.content?.trim().slice(0, 32_000)
      const calls = planner.tool_calls ?? []
      if (reply && !['RUNNING', 'PENDING', 'IN_PROGRESS'].includes(planner.status ?? '') && !child.seen.has(key + ':reply')) {
        child.seen.add(key + ':reply')
        events.push({ type: 'assistant_message', text: reply, parentToolUseId })
      }
      child.hasFinalReply = !!reply && calls.length === 0 && !['RUNNING', 'PENDING', 'IN_PROGRESS'].includes(planner.status ?? '')
      if (reply && calls.length === 0) child.report = reply
      let next = index + 1
      for (const [callIndex, call] of calls.entries()) {
        while (steps[next]?.type === 'CHECKPOINT') next++
        const candidate = steps[next]
        const result = candidate && !BOUNDARIES.has(candidate.type) ? steps[next++] : undefined
        const projected = toolCall(childId, planner, call, callIndex, result)
        events.push(...this.projectTool(childId, child, projected, normalizer, call.id))
      }
    }
  }

  private projectTool(childId: string, child: Child, call: AcpToolCall, normalizer: AcpTurnNormalizer, nativeToolId?: string): NormalizedEvent[] {
    const providerId = nativeToolId && (nativeToolId.startsWith(childId + ':') ? nativeToolId : childId + ':' + nativeToolId)
    const id = call.toolCallId
    const existing = child.calls.get(id)
    if (existing?.nativeId || child.seen.has(id)) return []
    if (!existing) {
      const key = signature(call)
      const claimed = new Set([...child.calls.values()].map((entry) => entry.nativeId))
      const nativeId = providerId && this.streamed.has(providerId) ? providerId : [...this.streamed].find(([streamId, stream]) =>
        streamId.startsWith(childId + ':') && !claimed.has(streamId) && stream.signature === key,
      )?.[0]
      child.calls.set(id, { id, signature: key, providerId, nativeId })
      if (nativeId) return []
    }
    if (call.status) {
      child.pending.delete(id)
      child.seen.add(id)
    } else {
      if (child.pending.has(id)) return []
      child.pending.set(id, call)
    }
    return normalizer.projectToolCall(call)
  }

  private repliesComplete(): boolean {
    const replies = new Map<string, number>()
    for (const child of this.children.values()) {
      if (child.hasFinalReply) replies.set(child.parent, (replies.get(child.parent) ?? 0) + 1)
    }
    return [...this.parents].every(([parent, count]) => (replies.get(parent) ?? 0) >= count)
  }

  private brain(sessionId: string, folder: string, file: string): string[] {
    return ['brain', sessionId, '.system_generated', folder, file]
  }

  /** Detached children name their parent and launch in a message record. */
  private async discover(): Promise<void> {
    const directory = managedPath(this.storage, this.brain(this.rootId, 'subagents', '').slice(0, -1), 'directory')
    if (!directory) return
    const files = await readdir(directory.path).catch(() => [])
    for (const file of files.slice(-256)) {
      const id = file.endsWith('.json') && file.slice(0, -5)
      if (!id || !idPattern.test(id) || this.children.has(id)) continue
      const record = descriptor.safeParse(decodeJson(await readFile(this.storage, this.brain(this.rootId, 'subagents', file), 16_384, false)))
      if (!record.success || record.data.conversationId !== id) continue
      const inbox = managedPath(this.storage, this.brain(id, 'messages', '').slice(0, -1), 'directory')
      if (!inbox) continue
      for (const name of (await readdir(inbox.path).catch(() => [])).slice(-64)) {
        if (!name.endsWith('.json')) continue
        const entry = message.safeParse(decodeJson(await readFile(this.storage, this.brain(id, 'messages', name), 65_536, false)))
        if (entry.success && entry.data.sender === this.rootId) {
          const parent = entry.data.sourceMetadata.tool.toolCall.id
          if (this.parents.has(parent)) {
            this.noteChild(id, parent)
            break
          }
        }
      }
    }
  }
}
