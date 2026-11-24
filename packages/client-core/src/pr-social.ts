import type { SolusAPI } from '@solus/contracts/host-api'
import type { RepoRef } from '@solus/contracts/providers'
import type {
  PrReaction,
  PrReactionContent,
  PrReactions
} from '@solus/contracts/pr-social'

/**
 * The reaction writes of one pull request page. Reactions are read with the
 * pull request, its comments, and its threads; this owner only holds what a
 * write changed until a read catches up. A write shows at once, its answer
 * (the target's reactions after the write) replaces that, and a read whose
 * reactions differ from the ones the write began from wins, as it is newer.
 * Writes run one at a time.
 */
export class PrReactionWrites {
  #overlays = new Map<string, Overlay>()
  #listeners = new Set<() => void>()
  #generation = 0
  #write = Promise.resolve()
  #version = 0
  constructor(
    private readonly api: () => Pick<SolusAPI, 'prReact'>,
    readonly repo: RepoRef,
    readonly number: number
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  /** Changes whenever what `shown` answers may have changed. */
  get version(): number {
    return this.#version
  }
  #put(key: string, overlay: Overlay | undefined): void {
    if (overlay) this.#overlays.set(key, overlay)
    else this.#overlays.delete(key)
    this.#version++
    for (const listener of this.#listeners) listener()
  }
  dispose(): void {
    this.#generation++
    this.#overlays.clear()
    this.#listeners.clear()
  }
  /** What to show for a target (`null` is the pull request itself), given
   *  the reactions its last read carried. */
  shown(targetId: string | null, read: PrReactions | undefined): PrReactions | undefined {
    const overlay = this.#overlays.get(targetId ?? PULL_REQUEST)
    return overlay && overlay.base === reactionsSignature(read) ? overlay.value : read
  }
  /** Adds the reaction when the viewer has not made it, and takes it back
   *  when they have. A failed write rejects and puts back what was shown. */
  toggle(targetId: string | null, content: PrReactionContent, read: PrReactions | undefined): Promise<void> {
    const current = this.shown(targetId, read)
    if (!current) return Promise.resolve()
    const key = targetId ?? PULL_REQUEST
    const add = !current.groups.some((group) => group.content === content && group.viewerHasReacted)
    const base = reactionsSignature(read)
    const before = this.#overlays.get(key)
    const generation = this.#generation
    const token = {}
    this.#put(key, { base, value: withReaction(current, content, add), token })
    const command = this.#write
      .catch(() => {})
      .then(async () => {
        if (generation !== this.#generation) return
        try {
          const value = await this.api().prReact({ repo: this.repo, number: this.number }, targetId, content, add)
          // A later toggle of this target is still waiting; its look stands.
          if (generation === this.#generation && this.#overlays.get(key)?.token === token)
            this.#put(key, { base, value, token })
        } catch (error) {
          if (generation === this.#generation && this.#overlays.get(key)?.token === token)
            this.#put(key, before)
          throw error
        }
      })
    this.#write = command
    return command
  }
}
interface Overlay {
  /** The read's reactions when the write began. */
  base: string
  value: PrReactions
  /** Which toggle wrote this overlay. */
  token: object
}
const PULL_REQUEST = 'pull-request'

function reactionsSignature(reactions: PrReactions | undefined): string {
  if (!reactions) return ''
  return reactions.groups
    .map((group) => `${group.content}:${group.count}:${group.viewerHasReacted ? 1 : 0}`)
    .join(' ')
}
/** The reactions as they will be once the write lands. */
export function withReaction(reactions: PrReactions, content: PrReactionContent, add: boolean): PrReactions {
  const held = reactions.groups.find((group) => group.content === content)
  if (add === (held?.viewerHasReacted ?? false)) return reactions
  const count = (held?.count ?? 0) + (add ? 1 : -1)
  const groups = held
    ? reactions.groups.map((group) => (group === held ? { ...group, count, viewerHasReacted: add } : group))
    : [...reactions.groups, { content, count, viewerHasReacted: add, actors: [] }]
  return { ...reactions, groups: groups.filter((group) => group.count > 0) }
}
export const PR_REACTIONS: Array<{ content: PrReactionContent; label: string; name: string }> = [
  { content: 'THUMBS_UP', label: '👍', name: 'Thumbs up' },
  { content: 'THUMBS_DOWN', label: '👎', name: 'Thumbs down' },
  { content: 'LAUGH', label: '😄', name: 'Laugh' },
  { content: 'HOORAY', label: '🎉', name: 'Celebrate' },
  { content: 'CONFUSED', label: '😕', name: 'Confused' },
  { content: 'HEART', label: '❤️', name: 'Heart' },
  { content: 'ROCKET', label: '🚀', name: 'Rocket' },
  { content: 'EYES', label: '👀', name: 'Eyes' }
]

export interface ShownReaction extends PrReaction {
  label: string
  name: string
}
/** The reactions someone made, in GitHub's order. */
export function shownReactions(reactions: PrReactions | undefined): ShownReaction[] {
  return PR_REACTIONS.flatMap((choice) => {
    const group = reactions?.groups.find((item) => item.content === choice.content)
    return group && group.count > 0 ? [{ ...group, label: choice.label, name: choice.name }] : []
  })
}
const NAMED_REACTORS = 3
/** Who reacted, as GitHub says it: the viewer first, up to three names,
 *  then how many more. */
export function reactionSummary(reaction: ShownReaction): string {
  const names = (reaction.viewerHasReacted ? ['You', ...reaction.actors] : reaction.actors).slice(
    0,
    Math.min(NAMED_REACTORS, reaction.count)
  )
  const others = reaction.count - names.length
  const rest =
    others === 0
      ? []
      : names.length > 0
        ? [`${others} ${others === 1 ? 'other' : 'others'}`]
        : [`${others} ${others === 1 ? 'person' : 'people'}`]
  return `${conjunction([...names, ...rest])} reacted with ${reaction.name.toLowerCase()}`
}
function conjunction(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}
