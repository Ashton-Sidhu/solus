import type { McpAppPermission } from '@solus/contracts/mcp-apps'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'

const NO_PERMISSIONS: McpAppPermission[] = []

/** What the person set up for each app card: one map for each field, so a height change does not wake a permission reader. */
class McpAppFields {
  readonly closed = new SvelteSet<string>()
  readonly heights = new SvelteMap<string, number>()
  /** The context each app gave the agent. */
  readonly contexts = new SvelteMap<string, string>()
  readonly permissions = new SvelteMap<string, McpAppPermission[]>()
  /** The one app in picture-in-picture (docs/plans/mcp-first-class.md §14.2), and the turn of its card, which the virtualizer keeps mounted. */
  pip = $state<{ appKey: string; turnKey: string } | null>(null)
  /** The lower corner the frame sits in. */
  pipSide = $state<'end' | 'start'>('end')
}

/** One app card's view: by activity, or by tool-use id for a live card until it takes its saved app. */
export class McpAppView {
  readonly #fields: McpAppFields
  readonly #appKey: string

  constructor(fields: McpAppFields, appKey: string) {
    this.#fields = fields
    this.#appKey = appKey
  }

  get isClosed() {
    return this.#fields.closed.has(this.#appKey)
  }

  get height() {
    return this.#fields.heights.get(this.#appKey)
  }

  /** Undefined when the app gave the agent none. */
  get modelContext() {
    return this.#fields.contexts.get(this.#appKey)
  }

  get permissions(): McpAppPermission[] {
    return this.#fields.permissions.get(this.#appKey) ?? NO_PERMISSIONS
  }

  get isPip() {
    return this.#fields.pip?.appKey === this.#appKey
  }

  get pipSide() {
    return this.#fields.pipSide
  }

  close(): void {
    this.#fields.closed.add(this.#appKey)
  }

  show(): void {
    this.#fields.closed.delete(this.#appKey)
  }

  setHeight(height: number): void {
    this.#fields.heights.set(this.#appKey, height)
  }

  /** An empty text means the app took its context back. */
  setModelContext(text: string): void {
    if (text) this.#fields.contexts.set(this.#appKey, text)
    else this.#fields.contexts.delete(this.#appKey)
  }

  grant(permissions: readonly McpAppPermission[]): void {
    this.#fields.permissions.set(this.#appKey, [...this.permissions, ...permissions])
  }

  /** The app there before goes back to its card. */
  showPip(turnKey: string): void {
    this.#fields.pip = { appKey: this.#appKey, turnKey }
  }

  /** Only when this app is the one in picture-in-picture. */
  returnPip(): void {
    if (this.isPip) this.#fields.pip = null
  }

  movePip(): void {
    this.#fields.pipSide = this.#fields.pipSide === 'end' ? 'start' : 'end'
  }
}

/** The app cards of one conversation, owned by its `ConversationViewState`. */
export class McpAppViews {
  readonly #fields = new McpAppFields()
  readonly #views = new Map<string, McpAppView>()

  /** The same view each time for a key: a card reads it in its template. */
  view(appKey: string): McpAppView {
    let view = this.#views.get(appKey)
    if (!view) {
      view = new McpAppView(this.#fields, appKey)
      this.#views.set(appKey, view)
    }
    return view
  }

  get pipTurnKey() {
    return this.#fields.pip?.turnKey ?? null
  }

  /** A live card took its saved app: all the person set up under the tool-use id moves to the activity id. */
  adopt(fromKey: string, toKey: string): void {
    const { closed, heights, contexts, permissions } = this.#fields
    if (closed.delete(fromKey)) closed.add(toKey)
    moveEntry(heights, fromKey, toKey)
    moveEntry(contexts, fromKey, toKey)
    moveEntry(permissions, fromKey, toKey)
    if (this.#fields.pip?.appKey === fromKey) this.#fields.pip.appKey = toKey
  }
}

function moveEntry<T>(map: SvelteMap<string, T>, fromKey: string, toKey: string): void {
  const value = map.get(fromKey)
  if (value === undefined) return
  map.delete(fromKey)
  map.set(toKey, value)
}
