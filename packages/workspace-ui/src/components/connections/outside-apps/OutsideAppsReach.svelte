<script lang="ts">
  /** "Where apps reach this host" (plans/035 §0.8): Anywhere (an internet
   *  address, for cloud apps), your devices (the tailnet), and this computer,
   *  each with its address to copy. The host tests each address from outside
   *  once the page shows it, and the row says how the test went. "Set up" and
   *  "Change" open the three ways to give the host an address. */
  import { untrack } from "svelte";
  import { connectionsStore } from "../../../contexts";
  import { Button } from "../../ui/button";
  import { addressHealth, appAddressSourceLabel, appAddressTestText, reachRows, type AppAddressReach } from "../lib/app-addresses";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppsAddressWays from "./OutsideAppsAddressWays.svelte";

  interface Props {
    serverId: string;
    hostName: string;
  }

  let { serverId, hostName }: Props = $props();

  let setupReach = $state<AppAddressReach | null>(null);
  let copiedUrl = $state<string | null>(null);

  const endpoint = $derived(connectionsStore.appEndpointFor(serverId));
  const endpointError = $derived(connectionsStore.appEndpointErrorFor(serverId));
  const rows = $derived(endpoint ? reachRows(endpoint, hostName) : []);
  const tests = $derived(connectionsStore.appAddressTestsFor(serverId));

  // Each address is tested once for its current url; "Check again" forgets the tests.
  $effect(() => {
    const untested = rows.filter((row) => row.source && row.url && tests[row.source]?.url !== row.url);
    untrack(() => {
      for (const row of untested) if (row.source) void connectionsStore.testAppAddress(serverId, row.source);
    });
  });

  async function copy(url: string) {
    if (!(await outsideApps.copy("address", url))) return;
    copiedUrl = url;
    setTimeout(() => { if (copiedUrl === url) copiedUrl = null; }, 1500);
  }
</script>

<section class="@container/reach flex flex-col gap-1" aria-labelledby="outside-apps-reach-title">
  <div class="flex flex-col gap-1 border-b border-border pb-3">
    <h2 id="outside-apps-reach-title" class="text-[0.9375rem] leading-4.5 font-semibold text-(--solus-text-primary)">Where apps reach this host</h2>
    <p class="text-[0.8125rem] leading-[1.45] text-(--solus-text-tertiary)">Apps in the cloud, like Claude and ChatGPT, need an address on the internet.</p>
  </div>
  {#if endpointError}
    <p role="alert" class="py-3.5 text-[0.8125rem] text-(--solus-status-error)">{endpointError}</p>
  {:else if !endpoint}
    <p class="py-3.5 text-[0.8125rem] text-(--solus-text-tertiary)">Reading addresses…</p>
  {:else}
    {#each rows as row (row.place)}
      {@const test = row.source ? tests[row.source] : undefined}
      {@const health = row.url && row.source ? addressHealth(test, row.url) : row.url ? "answers" : null}
      {@const result = row.source && row.url ? appAddressTestText(test, row.url) : null}
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border py-3.5 last:border-b-0">
        <div class="flex w-45 shrink-0 flex-col gap-0.5 @max-[30rem]/reach:w-full">
          <span class="text-[0.875rem] leading-4.5 font-medium text-(--solus-text-primary)">{row.label}</span>
          <span class="text-[0.8125rem] leading-4 text-(--solus-text-tertiary)">{row.source === "tailscale-funnel" ? appAddressSourceLabel(row.source) : row.detail}</span>
        </div>
        <div class="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <div class="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              class={[
                "size-1.75 shrink-0 rounded-full",
                health === "answers" ? "bg-(--solus-status-complete)" : health === "fails" ? "bg-(--solus-status-error)" : health === "untested" ? "bg-(--solus-text-tertiary)" : "bg-border",
              ]}
            ></span>
            {#if row.url}
              <span class="min-w-0 truncate text-[0.8125rem] leading-4 text-(--solus-text-primary) select-text">{row.url}</span>
            {:else}
              <span class="text-[0.8125rem] leading-4 text-(--solus-text-secondary)">Not set up yet</span>
            {/if}
          </div>
          {#if row.source && row.url}
            <p aria-live="polite" class={[
              "pl-3.75 text-chrome-dense select-text",
              health === "answers" ? "text-(--solus-status-complete)" : health === "fails" ? "text-(--solus-status-error)" : "text-(--solus-text-tertiary)",
            ]}>{health === "answers" ? "Address check passed" : result ?? "Testing the address…"}</p>
          {/if}
        </div>
        <div class="flex shrink-0 items-center justify-end gap-1">
          {#if row.source && health === "fails"}
            {@const source = row.source}
            <Button variant="outline" size="sm" aria-label={`Check the ${row.label.toLowerCase()} address again`} onclick={() => void connectionsStore.testAppAddress(serverId, source)}>
              Check again
            </Button>
          {/if}
          {#if row.url}
            {@const url = row.url}
            <Button variant="ghost" size="sm" class="text-(--solus-text-secondary)" aria-label={`Copy the ${row.label.toLowerCase()} address`} onclick={() => void copy(url)}>
              {copiedUrl === url ? "Copied" : "Copy"}
            </Button>
          {/if}
          {#if row.setupReach}
            {@const reach = row.setupReach}
            <Button variant="outline" size="sm" aria-expanded={setupReach === reach} onclick={() => (setupReach = setupReach === reach ? null : reach)}>
              {row.url ? "Change" : "Set up"}
            </Button>
          {/if}
        </div>
      </div>
      {#if setupReach !== null && setupReach === row.setupReach}
        <div class="border-b border-border pb-4">
          <OutsideAppsAddressWays {serverId} {hostName} reach={setupReach} />
        </div>
      {/if}
    {/each}
  {/if}
</section>
