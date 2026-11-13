<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronRight, Cloud, Link2, QrCode, RefreshCw, Sparkles, Terminal } from "@lucide/svelte";
  import { managedHostsStore } from "../../contexts";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import AddCloudMachine from "./AddCloudMachine.svelte";
  import AddPairMachine from "./AddPairMachine.svelte";
  import FoundMachineRow from "./FoundMachineRow.svelte";
  import LinkMachinePanel from "./LinkMachinePanel.svelte";
  import { openSshAdd } from "./add-machine";
  import { discoverStore } from "./discover.store.svelte";
  import { recommendedAddWay, type AddWay } from "./lib/fleet-model";

  /**
   * Add a machine (docs/plans/host-fleet.md D8): Nearby is always first, and a
   * machine in reach is one action away. Below it, the other ways as one choice;
   * the chosen way opens in place and finishes here. Only SSH has its own form.
   */
  type OtherWay = Exclude<AddWay, "nearby">;

  const ways: Array<{ way: OtherWay; title: string; detail: string }> = [
    { way: "cloud", title: "Create a cloud machine", detail: "Solus runs it for you. It is ready in about a minute." },
    { way: "link", title: "Link a machine you own", detail: "Run one command on any Mac, Linux, or Windows machine." },
    { way: "pair", title: "Pair with a code", detail: "For a machine that already runs Solus." },
    { way: "ssh", title: "Add over SSH", detail: "Solus installs itself on a host you reach with SSH." },
  ];

  let chosen = $state<OtherWay | null>(
    connectionsNav.addWay && connectionsNav.addWay !== "nearby" && connectionsNav.addWay !== "ssh" ? connectionsNav.addWay : null,
  );

  const found = $derived(discoverStore.found);
  const recommended = $derived(recommendedAddWay(found.length, managedHostsStore.canCreate));
  const orderedWays = $derived([...ways.filter((entry) => entry.way === recommended), ...ways.filter((entry) => entry.way !== recommended)]);

  onMount(() => {
    void managedHostsStore.loadCatalog();
    if (connectionsNav.addWay === "ssh") openSshAdd();
    return discoverStore.watch();
  });

  function choose(way: OtherWay) {
    if (way === "ssh") return openSshAdd();
    chosen = chosen === way ? null : way;
  }
</script>

<div class="flex flex-col gap-10">
  <div class="flex flex-col gap-1.5">
    <h1 class="text-[1.375rem] font-medium tracking-[-0.01em]">Add a machine</h1>
    <p class="max-w-xl text-[0.8125rem] text-pretty text-(--solus-text-secondary)">
      Each way finishes on this page, and the machine shows on your map when it is ready.
    </p>
  </div>

  <SettingsSection label="Nearby" description="Machines this device can already see. Connect one in a step.">
    {#snippet action()}
      <span class="flex items-center gap-1.5">
        {#if recommended === "nearby"}
          <span class="inline-flex h-[1.1875rem] items-center gap-1 rounded-md bg-(--solus-status-running-bg) pr-[7px] pl-[5px] text-chrome-dense text-(--solus-status-running)">
            <Sparkles size={11} />Recommended
          </span>
        {/if}
        <Button variant="ghost" size="sm" disabled={discoverStore.isScanning} onclick={() => void discoverStore.scan()}>
          <RefreshCw size={13} class={discoverStore.isScanning ? "animate-spin motion-reduce:animate-none" : ""} />
          {discoverStore.isScanning ? "Scanning…" : "Scan again"}
        </Button>
      </span>
    {/snippet}
    {#each found as machine (machine.key)}
      <FoundMachineRow {machine} />
    {:else}
      <p class="px-4 py-3.5 text-[0.8125rem] text-(--solus-text-secondary)">
        {discoverStore.isScanning ? "Looking on your network, on Tailscale, and in your SSH config…" : "No machine nearby yet. Choose another way below."}
      </p>
    {/each}
  </SettingsSection>

  <section class="flex flex-col gap-3">
    <h2 class="text-base font-medium tracking-[-0.01em] text-foreground">Other ways</h2>
    <div role="radiogroup" aria-label="How to add a machine" class="flex flex-col gap-2">
      {#each orderedWays as entry (entry.way)}
        {@const isOpen = chosen === entry.way}
        {@const isRecommended = entry.way === recommended}
        <div class="overflow-hidden rounded-xl border bg-background {isOpen ? 'border-(--solus-status-running)/45' : isRecommended ? 'border-(--solus-status-running)/30' : 'border-border/50'}">
          <button
            type="button"
            role="radio"
            aria-checked={isOpen}
            onclick={() => choose(entry.way)}
            class="flex w-full items-center gap-3.5 px-4 py-3.5 text-left hover:bg-(--wash-1)"
          >
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg {isOpen || isRecommended ? 'bg-(--solus-status-running-bg) text-(--solus-status-running)' : 'bg-(--wash-3) text-muted-foreground'}">
              {#if entry.way === "cloud"}<Cloud size={16} />{:else if entry.way === "link"}<Link2 size={16} />{:else if entry.way === "pair"}<QrCode size={16} />{:else}<Terminal size={16} />{/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="flex flex-wrap items-center gap-2">
                <span class="text-workspace-chrome font-medium">{entry.title}</span>
                {#if isRecommended}
                  <span class="inline-flex h-[1.1875rem] items-center gap-1 rounded-md bg-(--solus-status-running-bg) pr-[7px] pl-[5px] text-chrome-dense text-(--solus-status-running)">
                    <Sparkles size={11} />Recommended
                  </span>
                {/if}
              </span>
              <span class="text-[0.8125rem] text-muted-foreground">{entry.detail}</span>
            </span>
            <ChevronRight size={15} class="shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none {isOpen ? 'rotate-90' : ''}" />
          </button>
          {#if isOpen}
            <div class="border-t border-border/40 px-4 py-4">
              {#if entry.way === "cloud"}<AddCloudMachine />
              {:else if entry.way === "link"}<LinkMachinePanel />
              {:else if entry.way === "pair"}<AddPairMachine />{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>
</div>
