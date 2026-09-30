<script lang="ts">
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import PresenceStack from "../presence/PresenceStack.svelte";
  import type { PresencePerson } from "../presence/lib/presence-people";

  /**
   * Who else has this work open, for its header (docs/plans/work-review-and-live-editing.md,
   * phase 3a): the people whose focused pane shows it, from the host room, with
   * "editing…" under whoever changes it now. Absent when the reader is alone.
   */
  interface Props {
    serverId: string | null;
    workId: string;
  }
  let { serverId, workId }: Props = $props();

  $effect(() => {
    if (serverId) void presenceStore.ensure(serverId);
  });

  const people = $derived(serverId ? presenceStore.peopleFocusedOn(serverId, { kind: "work", workId }) : []);

  function detail(person: PresencePerson): string | null {
    if (person.isEditing) return "editing…";
    return person.deviceCount > 1 ? `${person.deviceCount} devices` : null;
  }
</script>

<PresenceStack {people} size={18} {detail} class="px-0.5" />
