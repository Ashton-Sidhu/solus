import { getContext, onDestroy, setContext, untrack } from 'svelte';
import { PrReactionWrites } from '@solus/client-core/pr-social';
import { serverConnections } from '@solus/client-core/server-connections';
import type { PrReactionContent, PrReactions } from '@solus/contracts/pr-social';
import type { RepoRef } from '@solus/contracts/providers';
import { getSettingsContext } from '../../../contexts';
import { toasts } from '../../../lib/toasts';

const KEY = Symbol('pr-reactions');

/** The pull request a page writes reactions for. */
export interface PrReactionsSubject {
  serverId: string;
  repo: RepoRef;
  number: number;
}

/** The reaction writes of one pull request page. The reactions themselves
 *  come with the pull request, its comments, and its threads; every bar on
 *  the page passes them in, and this owner shows a write over them until a
 *  read catches up (`PrReactionWrites`). */
export class PrPageReactions {
  /** Changes when a write changes what a bar shows. */
  #version = $state(0);
  #writes: PrReactionWrites | null = null;
  #subjectKey: string | null = null;
  #stop: (() => void) | null = null;

  constructor(private readonly accountKey: () => string) {}

  /** Follows the page's pull request. A new pull request, host, or account
   *  drops the writes shown for the last one. */
  follow(subject: PrReactionsSubject | null): void {
    const accountKey = this.accountKey();
    const key = subject
      ? JSON.stringify([subject.serverId, subject.repo.host, subject.repo.owner, subject.repo.repo, subject.number, accountKey])
      : null;
    if (key === this.#subjectKey) return;
    untrack(() => {
      this.close();
      if (!subject) return;
      const { serverId, number } = subject;
      const writes = new PrReactionWrites(
        () => {
          if (this.accountKey() !== accountKey)
            throw new Error('The account changed. Refresh this PR.');
          return serverConnections.apiFor(serverId);
        },
        { host: subject.repo.host, owner: subject.repo.owner, repo: subject.repo.repo },
        number,
      );
      const stop = writes.subscribe(() => this.#version++);
      this.#writes = writes;
      this.#subjectKey = key;
      this.#stop = () => {
        stop();
        writes.dispose();
      };
      this.#version++;
    });
  }

  close(): void {
    this.#stop?.();
    this.#stop = null;
    this.#writes = null;
    this.#subjectKey = null;
  }

  /** What a bar shows for a target (`null` is the pull request itself). */
  shown(targetId: string | null, read: PrReactions | undefined): PrReactions | undefined {
    void this.#version;
    return this.#writes?.shown(targetId, read) ?? read;
  }

  /** False until the page knows which pull request it writes to. */
  get canWrite(): boolean {
    void this.#version;
    return this.#writes !== null;
  }

  toggle(targetId: string | null, content: PrReactionContent, read: PrReactions | undefined): void {
    void this.#writes?.toggle(targetId, content, read).catch((error) =>
      toasts.error('Could not change the reaction', {
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Gives a pull request page its reaction writes. Call during component init. */
export function providePrReactions(): PrPageReactions {
  const settings = getSettingsContext();
  const reactions = new PrPageReactions(() => settings.personal.accountKey);
  setContext(KEY, reactions);
  onDestroy(() => reactions.close());
  return reactions;
}

/** Absent outside a pull request page, so a thread card in the Diff tab
 *  shows its reactions without a way to change them. */
export function getPrReactions(): PrPageReactions | undefined {
  return getContext<PrPageReactions | undefined>(KEY);
}
