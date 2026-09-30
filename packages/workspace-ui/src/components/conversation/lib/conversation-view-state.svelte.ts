import type { Tab } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
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
  readonly virtualizer = new TranscriptVirtualizer()
  /** The row and offset the reader was at; null while they follow the end. */
  position: TranscriptPosition | null = null
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
