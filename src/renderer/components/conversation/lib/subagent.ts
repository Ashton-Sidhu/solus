import type { Message } from '../../../../shared/types'
import { prettyToolName, solusToolKey } from '../../../contexts/session.utils'

/** A sub-agent transcript item: consecutive tool calls collapse into one group;
 *  assistant text renders on its own. Mirrors the main-thread grouping. */
export type SubItem =
  | { kind: 'tool-group'; messages: Message[] }
  | { kind: 'assistant'; message: Message }

export type SubagentInput = {
  subagent_type?: string
  description?: string
  prompt?: string
  task?: string
  instructions?: string
  model?: string
  reasoning_effort?: string
}

export function parseSubagentInput(toolInput: string | undefined): SubagentInput {
  const input = toolInput?.trim()
  if (!input) return {}
  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as SubagentInput
      : { prompt: input }
  } catch {
    return { prompt: input }
  }
}

export function subagentInputText(input: SubagentInput): string {
  for (const value of [input.prompt, input.task, input.instructions]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// A sub-tool's toolInput carries whole file bodies (Write/Edit) and can still
// change while running (Codex patch updates replace it). Parse each sub message
// at most once, cached on the message object, and never while it's running —
// the cache would otherwise pin a stale parse. Module-scoped WeakMap so the card
// (ticker) and the pane (transcript) share one parse per message.
const subParseCache = new WeakMap<Message, Record<string, unknown> | null>()

export function parseSubInput(m: Message): Record<string, unknown> | null {
  if (!m.toolInput || m.toolStatus === 'running') return null
  const cached = subParseCache.get(m)
  if (cached !== undefined) return cached
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(m.toolInput) as Record<string, unknown>
  } catch {}
  subParseCache.set(m, parsed)
  return parsed
}

/** Short label for a sub-tool, used by the running ticker. */
export function subToolLabel(m: Message): string {
  const name = m.toolName || 'Tool'
  if (solusToolKey(name)) return prettyToolName(name)
  // Running / unparseable: cheap fallback, never parse the growing partial JSON.
  const parsed = parseSubInput(m)
  if (!parsed) return prettyToolName(name)
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const arg =
    s(parsed.file_path) || s(parsed.path) || s(parsed.pattern) || s(parsed.query) || s(parsed.command)
  return arg ? `${prettyToolName(name)} ${arg}` : prettyToolName(name)
}

/** Tool count + distinct files touched (Write/Edit) across the sub-transcript. */
export function subStats(subs: Message[]): { toolCount: number; filesTouched: number } {
  let toolCount = 0
  const files = new Set<string>()
  for (const m of subs) {
    if (m.role !== 'tool') continue
    toolCount++
    if (m.toolName !== 'Write' && m.toolName !== 'Edit') continue
    const fp = parseSubInput(m)?.file_path
    if (typeof fp === 'string' && fp) files.add(fp)
  }
  return { toolCount, filesTouched: files.size }
}

export function groupSubMessages(subs: Message[]): SubItem[] {
  const result: SubItem[] = []
  let buf: Message[] = []
  const flush = () => {
    if (buf.length > 0) {
      result.push({ kind: 'tool-group', messages: buf })
      buf = []
    }
  }
  for (const m of subs) {
    if (m.role === 'tool') buf.push(m)
    else if (m.role === 'assistant' && m.content.trim()) {
      flush()
      result.push({ kind: 'assistant', message: m })
    }
  }
  flush()
  return result
}
