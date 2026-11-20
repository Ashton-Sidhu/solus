<script lang="ts">
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import type { Message } from "@solus/contracts/types";
  import TurnImageCard from "./TurnImageCard.svelte";
  import { messageImages } from "./lib/turn-images";
  import BrowserSnapshots from "../browser/BrowserSnapshots.svelte";

  let { message, serverId, snapshots = [] }: { message: Message; serverId?: string; snapshots?: BrowserSnapshotRef[] } = $props();
  const images = $derived(messageImages(message));
</script>

{#if message.browserSnapshot}
  <BrowserSnapshots snapshots={snapshots.length ? snapshots : [message.browserSnapshot]} focusSnapshot={message.browserSnapshot} {serverId} />
{:else}
  {#each images as image, index (index)}
    <TurnImageCard {image} {serverId} />
  {/each}
{/if}
