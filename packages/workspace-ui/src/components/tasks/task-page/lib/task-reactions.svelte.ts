import { SvelteMap } from 'svelte/reactivity';
import { withReaction } from '@solus/client-core/pr-social';
import type { TaskDataStore } from '@solus/client-core/task-data';
import type { PrReactionContent, PrReactions } from '@solus/contracts/pr-social';
import type { TaskReaction } from '@solus/contracts/task-data';
import { toasts } from '../../../../lib/toasts';
import type { ReactionWrites } from '../../../prs/lib/pr-reactions.svelte';

/** The reactions of one target (the issue or one comment) in the shape the
 *  pull request reaction bar draws. The provider does not say who reacted. */
export function taskReactions(
  reactions: readonly TaskReaction[],
  targetId: string,
  viewerCanReact: boolean,
): PrReactions {
  return {
    viewerCanReact,
    groups: reactions
      .filter((reaction) => reaction.targetId === targetId && reaction.count > 0)
      .map(({ content, count, viewerHasReacted }) => ({ content, count, viewerHasReacted, actors: [] })),
  };
}

interface Overlay {
  data: TaskDataStore;
  value: PrReactions;
}

/** The reaction writes of one issue page. A write shows at once and stays
 *  until `TaskDataStore.react` has read the provider again. A target of
 *  `null` is the issue itself. */
export class TaskPageReactions implements ReactionWrites {
  #overlays = new SvelteMap<string, Overlay>();

  constructor(private readonly target: () => { data: TaskDataStore | undefined; issueId: string }) {}

  get canWrite(): boolean {
    return !!this.target().data;
  }

  shown(targetId: string | null, read: PrReactions | undefined): PrReactions | undefined {
    const overlay = this.#overlays.get(targetId ?? ISSUE);
    return overlay && overlay.data === this.target().data ? overlay.value : read;
  }

  toggle(targetId: string | null, content: PrReactionContent, read: PrReactions | undefined): void {
    const { data, issueId } = this.target();
    const current = this.shown(targetId, read);
    if (!data || !current) return;
    const key = targetId ?? ISSUE;
    const add = !current.groups.some((group) => group.content === content && group.viewerHasReacted);
    const overlay = { data, value: withReaction(current, content, add) };
    this.#overlays.set(key, overlay);
    data
      .react(targetId ?? issueId, content, add)
      .catch((error) =>
        toasts.error('Could not change the reaction', {
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        // A later toggle of this target is still waiting; its look stands.
        if (this.#overlays.get(key) === overlay) this.#overlays.delete(key);
      });
  }
}

const ISSUE = 'issue';
