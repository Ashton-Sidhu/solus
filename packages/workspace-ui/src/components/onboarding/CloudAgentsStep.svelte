<script lang="ts">
  /**
   * The Agents step of the cloud flow (docs/plans/one-page-onboarding.md
   * decision 5): the account's agent seats, which every cloud host uses. They
   * are connected on the account's Connections page in a new tab; coming back
   * to this tab reads them again.
   */
  import { onMount } from "svelte";
  import { cloudAgentSeatsStore as seats } from "../../contexts/seats/cloud-agent-seats.store.svelte";
  import { Button } from "../ui/button";
  import { SETUP_PROVIDERS } from "../servers/lib/host-onboarding";
  import { seatProviderFor } from "../servers/host-setup.store.svelte";
  import AgentRow from "./AgentRow.svelte";

  let opened = $state(false);

  onMount(() => seats.watch());

  function connect() {
    opened = true;
    seats.connect();
  }
</script>

{#if seats.error && seats.seats === null}
  <div class="flex min-h-12 items-center gap-3.5">
    <span class="w-5 shrink-0"></span>
    <p class="m-0 min-w-0 flex-1 text-[13px] leading-4.5 text-(--solus-status-error)" role="alert">{seats.error}</p>
    <Button variant="outline" size="sm" class="h-7.5 rounded-md px-3 text-[13px]" onclick={() => void seats.refresh()}>Try again</Button>
  </div>
{:else}
  {#each SETUP_PROVIDERS as provider (provider.id)}
    {@const connected = seats.connected(seatProviderFor(provider.id))}
    <AgentRow
      agent={provider.id}
      name={provider.label}
      detail={connected ? "Saved to your account" : opened ? "Finish on the Connections page, then come back" : "Not connected yet"}
      trailing={connected === null
        ? { kind: "busy", text: "Checking…" }
        : connected
          ? { kind: "synced", text: "Connected" }
          : { kind: "action", text: opened ? "Open again" : "Connect" }}
      onaction={connect}
    />
  {/each}
{/if}
