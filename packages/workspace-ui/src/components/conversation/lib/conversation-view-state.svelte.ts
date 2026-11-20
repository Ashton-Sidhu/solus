import type { McpAppPermission } from '@solus/contracts/mcp-apps'
import type { Tab } from '@solus/contracts/types'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { TranscriptDisclosure } from './transcript-disclosure.svelte'
import { TranscriptVirtualizer, type TranscriptPosition } from './transcript-virtualizer.svelte'

/**
 * What a reader set up in one conversation and expects to find again: which
 * turns and cards are open, the measured row heights, and where they were
 * reading. The pool unmounts cold conversations (`ConversationPool`), so this
 * lives outside the view and is handed back when the tab mounts again.
 */
export class ConversationViewState {
  readonly disclosure = new TranscriptDisclosure()
  readonly turnExpansion = new SvelteMap<string, boolean>()
  /** The app cards the person closed: by activity, or by tool-use id for a live card. */
  readonly closedMcpApps = new SvelteSet<string>()
  /** The frame heights of app cards: by activity, or by tool-use id for a live card. */
  readonly mcpAppHeights = new SvelteMap<string, number>()
  /** The context each app gave the agent, as the person can read it, by activity. */
  readonly mcpAppContexts = new SvelteMap<string, string>()
  /** The browser features the person granted each app: by activity, or by tool-use id for a live card. */
  readonly mcpAppPermissions = new SvelteMap<string, McpAppPermission[]>()
  /**
   * The one app frame in picture-in-picture over this conversation
   * (docs/plans/mcp-first-class.md §14.2): its card by activity, or by tool-use
   * id for a live card, and the turn that holds the card. The virtualizer keeps
   * that turn mounted, so the frame stays.
   */
  mcpAppPip = $state<{ appKey: string; turnKey: string } | null>(null)
  /** The lower corner of the conversation the frame sits in. */
  mcpAppPipSide = $state<'end' | 'start'>('end')
  /** The row and offset the reader was at; null while they follow the end. */
  position: TranscriptPosition | null = null
  readonly virtualizer = new TranscriptVirtualizer(
    () => this.position === null,
    () => (this.mcpAppPip ? [this.mcpAppPip.turnKey] : []),
  )

  isMcpAppPip(appKey: string): boolean {
    return this.mcpAppPip?.appKey === appKey
  }

  /** Puts one app in picture-in-picture; the app there before goes back to its card. */
  showMcpAppPip(appKey: string, turnKey: string): void {
    this.mcpAppPip = { appKey, turnKey }
  }

  /** Puts the app back in its card, when it is the one in picture-in-picture. */
  returnMcpAppPip(appKey: string): void {
    if (this.isMcpAppPip(appKey)) this.mcpAppPip = null
  }

  /** Moves the frame to the other lower corner. */
  moveMcpAppPip(): void {
    this.mcpAppPipSide = this.mcpAppPipSide === 'end' ? 'start' : 'end'
  }

  /** A live card took its saved app: the app keeps its mode under its activity id. */
  renameMcpAppPip(fromKey: string, toKey: string): void {
    if (this.mcpAppPip?.appKey === fromKey) this.mcpAppPip.appKey = toKey
  }
}

interface ViewStateOwner {
  tabs: Record<string, Tab>
}

/** One registry per workspace, keyed by tab. A closed tab's state is dropped
 *  with it; nothing here outlives the tab or the workspace. */
class ConversationViewStates {
  private byTab = new Map<string, ConversationViewState>()

  constructor(private readonly workspace: ViewStateOwner) {}

  forTab(tabId: string): ConversationViewState {
    for (const id of this.byTab.keys()) if (!this.workspace.tabs[id]) this.byTab.delete(id)
    let state = this.byTab.get(tabId)
    if (!state) {
      state = new ConversationViewState()
      this.byTab.set(tabId, state)
    }
    return state
  }
}

const registries = new WeakMap<ViewStateOwner, ConversationViewStates>()

export function conversationViewStates(workspace: ViewStateOwner): ConversationViewStates {
  let registry = registries.get(workspace)
  if (!registry) {
    registry = new ConversationViewStates(workspace)
    registries.set(workspace, registry)
  }
  return registry
}
