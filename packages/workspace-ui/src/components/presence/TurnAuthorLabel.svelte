<script lang="ts">
  import type { TurnAuthor } from "@solus/contracts/presence";
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import { initialsFor } from "../ui/list-page/list-page";
  import PresenceAvatar from "./PresenceAvatar.svelte";
  import type { PresencePerson } from "./lib/presence-people";

  /**
   * The name over a prompt somebody else wrote. The reader's own prompts stay
   * unlabelled, as they always were: a name on every bubble would make a
   * one-person session read as a meeting. Absent when the host stamped no
   * author (its own automations, a reloaded history).
   */
  interface Props {
    author: TurnAuthor | undefined;
    serverId: string | null | undefined;
  }
  let { author, serverId }: Props = $props();

  const selfUserIds = $derived(serverId ? presenceStore.selfUserIds(serverId) : []);
  // Unknown self (the snapshot has not arrived, or an older host) shows no name:
  // a wrong name on the reader's own prompt is worse than a missing one.
  const shown = $derived(!!author && selfUserIds.length > 0 && !selfUserIds.includes(author.userId));
  const person = $derived.by((): PresencePerson | null => {
    if (!author) return null;
    const built: PresencePerson = {
      userId: author.userId,
      displayName: author.displayName,
      initials: initialsFor(author.displayName),
      colorIndex: author.colorIndex,
      isComposing: false,
      deviceCount: 1,
      clientIds: [],
    };
    if (author.avatarUrl) built.avatarUrl = author.avatarUrl;
    return built;
  });
</script>

{#if shown && person}
  <span
    class="mb-[0.1875rem] flex items-center gap-1 text-xs font-medium text-(--solus-text-tertiary)"
    data-testid="turn-author"
  >
    <PresenceAvatar {person} size={14} />
    <span class="truncate">{person.displayName}</span>
  </span>
{/if}
