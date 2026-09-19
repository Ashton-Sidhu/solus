<script lang="ts">
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import { composingLabel } from "./lib/presence-people";
  import PresenceAvatar from "./PresenceAvatar.svelte";

  /**
   * "Alice is typing…" at the tail of the transcript, where her prompt will
   * land. Still text, not a pulsing ellipsis: the transcript is read, not
   * watched, and a line that holds is enough to say someone is about to speak.
   */
  interface Props {
    serverId: string | null | undefined;
    sessionId: string | null | undefined;
  }
  let { serverId, sessionId }: Props = $props();

  const people = $derived(serverId && sessionId ? presenceStore.sessionPeople(serverId, sessionId) : []);
  const typing = $derived(people.filter((person) => person.isComposing));
  const label = $derived(composingLabel(people));
</script>

{#if label}
  <div
    class="flex items-center justify-end gap-1.5 pt-2 pb-1 text-transcript-meta text-(--muted-foreground) animate-msg-in-up"
    data-testid="composing-line"
    aria-live="polite"
  >
    <span class="inline-flex items-center">
      {#each typing.slice(0, 3) as person (person.userId)}
        <PresenceAvatar {person} size={14} class="-ml-1 first:ml-0 ring-[1.5px] ring-background" />
      {/each}
    </span>
    <span>{label}</span>
  </div>
{/if}
