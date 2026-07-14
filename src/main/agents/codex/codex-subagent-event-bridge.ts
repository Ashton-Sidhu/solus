import type { NormalizedEvent } from '../../../shared/types'

export interface CodexSubagentInput {
  prompt: string
  description?: string
  model?: string
  reasoning_effort?: string
  read_only?: boolean
}

function inputKey(input: CodexSubagentInput): string {
  return JSON.stringify([
    input.prompt,
    input.description ?? '',
    input.model ?? '',
    input.reasoning_effort ?? '',
    input.read_only ?? false,
  ])
}

/** Correlates an in-process MCP invocation with Claude's outer tool-use id. */
export class CodexSubagentEventBridge {
  private readonly toolIdByIndex = new Map<number, string>()
  private readonly availableByInput = new Map<string, string[]>()
  private readonly waitersByInput = new Map<string, Array<(toolId: string) => void>>()

  observe(event: NormalizedEvent): void {
    if (event.type === 'tool_call' && event.toolName === 'mcp__solus__codex_subagent') {
      this.toolIdByIndex.set(event.index, event.toolId)
      return
    }
    if (event.type !== 'tool_call_complete' || !event.toolInput) return

    const toolId = this.toolIdByIndex.get(event.index)
    if (!toolId) return
    this.toolIdByIndex.delete(event.index)

    let input: CodexSubagentInput
    try {
      input = JSON.parse(event.toolInput) as CodexSubagentInput
    } catch {
      return
    }
    if (typeof input.prompt !== 'string') return

    const key = inputKey(input)
    const waiter = this.waitersByInput.get(key)?.shift()
    if (waiter) {
      waiter(toolId)
      if (this.waitersByInput.get(key)?.length === 0) this.waitersByInput.delete(key)
      return
    }
    const available = this.availableByInput.get(key) ?? []
    available.push(toolId)
    this.availableByInput.set(key, available)
  }

  claim(input: CodexSubagentInput): Promise<string> {
    const key = inputKey(input)
    const available = this.availableByInput.get(key)
    const toolId = available?.shift()
    if (toolId) {
      if (available?.length === 0) this.availableByInput.delete(key)
      return Promise.resolve(toolId)
    }
    return new Promise((resolve) => {
      const waiters = this.waitersByInput.get(key) ?? []
      waiters.push(resolve)
      this.waitersByInput.set(key, waiters)
    })
  }
}
