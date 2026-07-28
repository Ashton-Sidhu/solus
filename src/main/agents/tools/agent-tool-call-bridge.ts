import type { NormalizedEvent } from '../../../shared/types'

function inputKey(toolName: string, input: unknown): string {
  return `${toolName}\0${JSON.stringify(input ?? {})}`
}

/**
 * Claude's in-process MCP handler receives the tool arguments but no stable
 * tool-use id. The normalized event stream carries that id separately, so this
 * bridge joins the two by tool name and input. Subagent tools use the recovered
 * id as `parentToolUseId` so their streamed child events render under the
 * correct parent tool card, including when several calls run concurrently.
 */
export class AgentToolCallBridge {
  private readonly toolByIndex = new Map<number, { name: string; id: string }>()
  private readonly available = new Map<string, string[]>()
  private readonly waiters = new Map<string, Array<(toolId: string) => void>>()

  observe(event: NormalizedEvent): void {
    if (event.type === 'tool_call') {
      this.toolByIndex.set(event.index, { name: event.toolName, id: event.toolId })
      return
    }
    if (event.type !== 'tool_call_complete' || !event.toolInput) return
    const pending = this.toolByIndex.get(event.index)
    if (!pending) return
    this.toolByIndex.delete(event.index)
    let input: unknown
    try { input = JSON.parse(event.toolInput) } catch { return }
    const bareName = pending.name.includes('__')
      ? pending.name.slice(pending.name.lastIndexOf('__') + 2)
      : pending.name
    const key = inputKey(bareName, input)
    const waiter = this.waiters.get(key)?.shift()
    if (waiter) {
      waiter(pending.id)
      if (this.waiters.get(key)?.length === 0) this.waiters.delete(key)
      return
    }
    const ids = this.available.get(key) ?? []
    ids.push(pending.id)
    this.available.set(key, ids)
  }

  claim(toolName: string, input: unknown): Promise<string> {
    const key = inputKey(toolName, input)
    const ids = this.available.get(key)
    const id = ids?.shift()
    if (id) {
      if (ids?.length === 0) this.available.delete(key)
      return Promise.resolve(id)
    }
    return new Promise((resolve) => {
      const callbacks = this.waiters.get(key) ?? []
      callbacks.push(resolve)
      this.waiters.set(key, callbacks)
    })
  }
}
