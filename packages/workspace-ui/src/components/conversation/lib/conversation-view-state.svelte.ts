import type { Tab } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { McpAppViews } from './mcp-app-views.svelte'
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
  /** What the person set up for each MCP App card: closed, height, context, permissions, picture-in-picture. */
  readonly mcpApps = new McpAppViews()
  /** The row and offset the reader was at; null while they follow the end. */
  position: TranscriptPosition | null = null
  /** The session folder whose repository the diff panel reads; null for the
   *  repository of the working directory (docs/plans/codebases.md §9). */
  diffRepositoryPath = $state<string | null>(null)
  /** The session folder whose repository the Git card of the project panel
   *  works in; null for the first repository of the session, which is the
   *  repository of the working directory (docs/plans/codebases.md §9). */
  gitRepositoryPath = $state<string | null>(null)
  /** The Git card of the project panel shows each repository of the session,
   *  not only the first ones: the person opened "Show N more". */
  gitRepositoriesExpanded = $state(false)
  /** The Environment panel shows all model groups when the user expands quota. */
  usageGroupsExpanded = $state(false)
  readonly virtualizer = new TranscriptVirtualizer(
    () => this.position === null,
    () => {
      const turnKey = this.mcpApps.pipTurnKey
      return turnKey ? [turnKey] : []
    },
  )
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
