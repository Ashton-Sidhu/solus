<script lang="ts">
  import type { PersonMention } from "@solus/contracts/mentions";
  import { sharesStore } from "../../contexts/sharing/shares.store.svelte";
  import { Button } from "../ui/button";
  import { getMentionContext } from "./lib/mention-context";
  import { mentionsWithoutAccess } from "./lib/mention-scope.svelte";

  // A mention never grants access. When a mentioned person cannot open the
  // record, the composer says so and offers the share dialog; the mention is
  // saved either way.
  let { people }: { people: readonly PersonMention[] } = $props();

  const scope = getMentionContext().scope;
  const blocked = $derived(mentionsWithoutAccess(scope(), people));
  const canShare = $derived.by(() => {
    const current = scope();
    return !!current && sharesStore.canShareFrom(current.serverId, current.resource.kind);
  });

  function openShare() {
    const current = scope();
    if (!current) return;
    void sharesStore.open({ serverId: current.serverId, resource: current.resource, title: current.title });
  }
</script>

{#if blocked.length > 0}
  <div
    class="flex min-w-0 items-center gap-2 text-xs text-(--solus-text-tertiary)"
    role="status"
    data-testid="mention-access-notice"
  >
    <span class="min-w-0 flex-1 truncate">
      {blocked.map((person) => person.name).join(", ")} cannot open this
    </span>
    {#if canShare}
      <Button variant="ghost" size="xs" class="shrink-0" onclick={openShare}>Share</Button>
    {/if}
  </div>
{/if}
