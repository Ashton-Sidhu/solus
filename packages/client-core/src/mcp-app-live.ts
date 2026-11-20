import type { McpAppLiveDocument, McpAppLiveRequest } from '@solus/contracts/mcp-apps'
import type { HostApi } from './host-api'
import type { McpAppLiveCall } from './mcp-app-host'

/** Answers kept for tool names; each one is small, most are null. */
const KEPT_ANSWERS = 64

/**
 * The live app cards of one host (docs/plans/mcp-first-class.md §14.1). The
 * host decides which tool has an app; its answer for a tool is asked once, a
 * null too. A mounted live card holds its call, so the saved card of the same
 * call stays hidden and hands its activity to the live card: the app keeps
 * its frame.
 */
export class McpAppLiveCards {
  private readonly answers = new Map<string, Promise<McpAppLiveDocument | null>>()
  private readonly holders = new Map<string, Set<(activityId: string) => void>>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly api: Pick<HostApi, 'mcpAppLiveRead'>) {}

  /** The app of a tool, or null. A read that fails is null, and the next call asks again. */
  document(request: McpAppLiveRequest): Promise<McpAppLiveDocument | null> {
    const key = `${request.sessionId}\0${request.toolName}`
    const kept = this.answers.get(key)
    if (kept) return kept
    const answer = this.api.mcpAppLiveRead(request).catch(() => {
      this.answers.delete(key)
      return null
    })
    this.answers.set(key, answer)
    for (const oldest of this.answers.keys()) {
      if (this.answers.size <= KEPT_ANSWERS) break
      this.answers.delete(oldest)
    }
    return answer
  }

  /** A mounted live card holds its call; `adopt` gets the activity of the call's saved app. Returns the release. */
  hold(sessionId: string, toolUseId: string, adopt: (activityId: string) => void): () => void {
    const key = `${sessionId}\0${toolUseId}`
    let holders = this.holders.get(key)
    if (!holders) {
      holders = new Set()
      this.holders.set(key, holders)
    }
    holders.add(adopt)
    this.changed()
    return () => {
      holders.delete(adopt)
      if (!holders.size) this.holders.delete(key)
      this.changed()
    }
  }

  isHeld(sessionId: string, toolUseId: string | undefined): boolean {
    return toolUseId !== undefined && this.holders.has(`${sessionId}\0${toolUseId}`)
  }

  /** The saved card of a held call gives its activity to the live card. */
  handOver(sessionId: string, toolUseId: string, activityId: string): void {
    for (const adopt of this.holders.get(`${sessionId}\0${toolUseId}`) ?? []) adopt(activityId)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

const cards = new WeakMap<HostApi, McpAppLiveCards>()

/** The live app cards of one host's API. */
export function mcpAppLiveFor(api: HostApi): McpAppLiveCards {
  let live = cards.get(api)
  if (!live) {
    live = new McpAppLiveCards(api)
    cards.set(api, live)
  }
  return live
}

/**
 * What a live card gives its bridge, from a transcript tool row. A call that
 * ended in an error after the person's Stop was stopped. The transcript does
 * not tell a denial or a timeout from another error, so both are `failed`.
 * A conversation that is hidden gets nothing while the call runs: its input
 * would only be healed and dropped. The newest arrives when it shows again.
 */
export function mcpAppLiveCall(
  tool: { input: string | null | undefined; status: 'running' | 'completed' | 'error' | undefined },
  isStopped: boolean,
  isVisible: boolean,
): McpAppLiveCall | null {
  const input = tool.input ?? ''
  if (tool.status === 'completed') return { input, end: 'completed' }
  if (isStopped) return { input, end: 'stopped' }
  if (tool.status === 'error') return { input, end: 'failed' }
  return isVisible ? { input, end: null } : null
}
