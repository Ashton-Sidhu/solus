<script lang="ts">
  import type { User } from "@solus/contracts/user";
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import UserChip from "../users/UserChip.svelte";
  import { otherPerson } from "./lib/actor-name";

  /**
   * The name over a prompt somebody else wrote. The reader's own prompts stay
   * unlabelled, as they always were: a name on every bubble would make a
   * one-person session read as a meeting. Absent when the host stamped no
   * author (its own automations, a reloaded history).
   */
  interface Props {
    author: User | undefined;
    serverId: string | null | undefined;
  }
  let { author, serverId }: Props = $props();

  const self = $derived(serverId ? presenceStore.currentUserId(serverId) : null);
  // Unknown self (the host has not said yet, or an older host) shows no name:
  // a wrong name on the reader's own prompt is worse than a missing one.
  const other = $derived(otherPerson(author, self));
</script>

{#if other}
  <span class="mb-[0.1875rem] flex text-xs" data-testid="turn-author">
    <UserChip user={other} />
  </span>
{/if}
