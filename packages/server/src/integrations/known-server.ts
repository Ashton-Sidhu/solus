import type { UpstreamResourceLists } from './resource-lists'
import { StdioProcessState } from './stdio-process'
import type { ServerFacts, UpstreamPrompt, UpstreamTool } from './upstream-session'

/**
 * What the gateway knows of one integration's server for one person
 * (docs/plans/mcp-integrations.md §5.1): the tools and facts their session
 * listed, their prompts and resources, and what their command's process left
 * behind. A change of the integration record drops it whole.
 */
export class KnownServer {
  /** The tools and the facts of the `initialize` answer; null until the first list, and after `tools/list_changed`. */
  facts: ServerFacts | null = null
  /** The resources and templates (§11.1); null until a list, after `resources/list_changed`, and after the session closes. */
  resources: UpstreamResourceLists | null = null
  /** What a stopped or failed command left behind (§7.3). */
  readonly process: StdioProcessState
  private toolListing: Promise<UpstreamTool[]> | null = null
  private promptListing: Promise<UpstreamPrompt[]> | null = null

  constructor(readonly integrationId: string, now: () => number) {
    this.process = new StdioProcessState(now)
  }

  /** The tools until their `ttlMs` ends, also when a closed session may have missed a change. */
  toolsWhileUnexpired(now: number): UpstreamTool[] | null {
    return this.facts && unexpired(this.facts.expiresAt, now) ? this.facts.tools : null
  }

  /** A closed session could not hear `tools/list_changed`: the next read lists again. */
  get stale(): boolean {
    return !!this.facts?.stale
  }

  /** The tools when no new list is needed. */
  toolsWhileFresh(now: number): UpstreamTool[] | null {
    return this.stale ? null : this.toolsWhileUnexpired(now)
  }

  promptsWhileFresh(now: number): UpstreamPrompt[] | null {
    const listed = this.facts?.prompts
    return listed && !this.stale && unexpired(listed.expiresAt, now) ? listed.prompts : null
  }

  resourcesWhileFresh(now: number): UpstreamResourceLists | null {
    return this.resources && unexpired(this.resources.expiresAt, now) ? this.resources : null
  }

  /** One tool list at a time: a caller that comes while one runs waits for that one. */
  listTools(read: () => Promise<UpstreamTool[]>): Promise<UpstreamTool[]> {
    this.toolListing ??= read().finally(() => { this.toolListing = null })
    return this.toolListing
  }

  listPrompts(read: () => Promise<UpstreamPrompt[]>): Promise<UpstreamPrompt[]> {
    this.promptListing ??= read().finally(() => { this.promptListing = null })
    return this.promptListing
  }

  /** The session closed, so a list-changed notification cannot reach it. */
  markStale(): void {
    if (this.facts) this.facts.stale = true
  }
}

function unexpired(expiresAt: number | null, now: number): boolean {
  return expiresAt === null || now < expiresAt
}
