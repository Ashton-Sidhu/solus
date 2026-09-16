<script lang="ts">
  import { Globe as GlobeIcon, Users as UsersIcon } from "@lucide/svelte";
  import type { ShareResource } from "@solus/contracts/sharing";
  import { sharesStore } from "../../contexts";
  import { shareSummary } from "./lib/share-rows";

  /**
   * The Share control (docs/plans/multiplayer-sharing.md §4.4): always present, and
   * shaped like the header it sits in. The session band's actions are glyphs, so
   * there it is a glyph: people at rest, a globe once a link exists. The work
   * header's actions are words, so there it is the word. The count and the state
   * ride the tooltip; the header stays as quiet as its neighbours.
   */
  interface Props {
    serverId: string | null | undefined;
    resource: ShareResource | null;
    title: string;
    appearance: "glyph" | "word";
    /** The caller's own action geometry, so the control reads as one of its header's. */
    class?: string;
  }
  let { serverId, resource, title, appearance, class: className = "" }: Props = $props();

  $effect(() => {
    if (serverId && resource) void sharesStore.load(serverId, resource);
  });

  const list = $derived(serverId && resource ? sharesStore.listFor(serverId, resource) : undefined);
  const summary = $derived(shareSummary(list));
  const sharedWithMe = $derived(!!list && list.callerRole !== "owner");
  const label = $derived(
    summary.count === 0
      ? "Share"
      : `${sharedWithMe ? "Shared with you" : "Shared"} · ${summary.count}${summary.hasLink ? " · anyone with the link" : ""}`,
  );
</script>

{#if serverId && resource}
  <button
    type="button"
    class={className}
    data-testid="share-button"
    data-shared={summary.count > 0 ? "true" : undefined}
    title={label}
    aria-label={label}
    onclick={() => sharesStore.open({ serverId, resource, title })}
  >
    {#if appearance === "glyph"}
      {#if summary.hasLink}<GlobeIcon size={14} />{:else}<UsersIcon size={14} />{/if}
    {:else}
      Share
    {/if}
  </button>
{/if}
