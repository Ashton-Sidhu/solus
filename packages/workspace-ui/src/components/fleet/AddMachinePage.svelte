<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronRight, Cloud, QrCode, RefreshCw, Terminal } from "@lucide/svelte";
  import { managedHostsStore } from "../../contexts";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import { Checkbox } from "../ui/checkbox";
  import AddCloudMachine from "./AddCloudMachine.svelte";
  import AddPairMachine from "./AddPairMachine.svelte";
  import FoundMachineRow from "./FoundMachineRow.svelte";
  import { openSshAdd } from "./add-machine";
  import { AddSeveral, canAddTogether } from "./add-several.svelte";
  import { discoverStore } from "./discover.store.svelte";
  import type { AddWay } from "./lib/fleet-model";

  /**
   * Add a machine: Nearby is always first, and a
   * machine in reach is one action away. Below it, the other ways as one choice;
   * the chosen way opens in place, its first field focused, and finishes here.
   * Only SSH has its own form. Several machines that run Solus are added at
   * once: select them, then Add; each pairs in the ways that need nobody at it,
   * and one that needs SSH or a code says so. A
   * machine added on any device joins all of a person's machines
   * (docs/plans/host-reach.md). Registering a host to a Solus Cloud account is
   * not a way to add it: it is a switch on the host's own page.
   */
  type OtherWay = Exclude<AddWay, "nearby">;

  const ways: Array<{ way: OtherWay; title: string; detail: string }> = [
    { way: "cloud", title: "Create a cloud machine", detail: "Solus runs it for you. It is ready in about a minute." },
    { way: "pair", title: "Pair with a code", detail: "For a machine that already runs Solus." },
    { way: "ssh", title: "Add over SSH", detail: "Solus installs itself on a host you reach with SSH." },
  ];

  let chosen = $state<OtherWay | null>(
    connectionsNav.addWay && connectionsNav.addWay !== "nearby" && connectionsNav.addWay !== "ssh" ? connectionsNav.addWay : null,
  );

  const found = $derived(discoverStore.found);
  const several = new AddSeveral();
  // Selection shows only when there is more than one machine to add together: for one, Connect does it.
  const canSelect = $derived(found.filter(canAddTogether).length > 1);
  const openCount = $derived(found.filter((machine) => canAddTogether(machine) && several.outcomes.get(machine.key)?.state !== "added").length);
  const chosenCount = $derived(found.filter((machine) => canAddTogether(machine) && several.selected.has(machine.key)).length);
  const isAllChosen = $derived(openCount > 0 && chosenCount === openCount);

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

  <SettingsSection label="Nearby" description="Machines this device can see. Connect one, or select several and add them together.">
    {#snippet action()}
      <Button variant="ghost" size="sm" disabled={discoverStore.isScanning} onclick={() => void discoverStore.scan()}>
        <RefreshCw size={13} class={discoverStore.isScanning ? "animate-spin motion-reduce:animate-none" : ""} />
        {discoverStore.isScanning ? "Scanning…" : "Scan again"}
      </Button>
    {/snippet}
    {#if canSelect}
      <!-- The selection bar: its box lines up with the boxes of the rows, and Add acts on what they choose. -->
      <div class="flex min-h-12 items-center gap-3 px-4 py-2">
        <label class="flex min-w-0 flex-1 items-center gap-3">
          <Checkbox
            checked={isAllChosen}
            indeterminate={chosenCount > 0 && !isAllChosen}
            disabled={several.isRunning || openCount === 0}
            onCheckedChange={() => several.toggleAll(found)}
            aria-label={isAllChosen ? "Select none" : "Select all"}
            class="pointer-coarse:size-5"
          />
          <span class="text-chrome-dense text-muted-foreground">
            {chosenCount > 0 ? `${chosenCount} of ${openCount} selected` : "Select all"}
          </span>
        </label>
        {#if chosenCount > 0 || several.isRunning}
          <Button size="sm" disabled={several.isRunning} onclick={() => void several.add(found)}>
            {several.isRunning ? "Adding…" : `Add ${chosenCount} ${chosenCount === 1 ? "machine" : "machines"}`}
          </Button>
        {/if}
      </div>
    {/if}
    {#each found as machine (machine.key)}
      <FoundMachineRow
        {machine}
        selection={canSelect && canAddTogether(machine) ? {
          isChosen: several.selected.has(machine.key),
          outcome: several.outcomes.get(machine.key),
          isLocked: several.isRunning,
          onToggle: (isChosen) => several.toggle(machine.key, isChosen),
        } : undefined}
      />
    {:else}
      <p class="px-4 py-3.5 text-[0.8125rem] text-(--solus-text-secondary)">
        {discoverStore.isScanning ? "Looking on your network, on Tailscale, and in your SSH config…" : "No machine nearby yet. Choose another way below."}
      </p>
    {/each}
  </SettingsSection>

  <section class="flex flex-col gap-3">
    <h2 class="text-base font-medium tracking-[-0.01em] text-foreground">Other ways</h2>
    <div role="radiogroup" aria-label="How to add a machine" class="flex flex-col gap-2">
      {#each ways as entry (entry.way)}
        {@const isOpen = chosen === entry.way}
        <div class="overflow-hidden rounded-xl border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none {isOpen ? 'border-(--solus-status-running)/45' : 'border-border'}">
          <button
            type="button"
            role="radio"
            aria-checked={isOpen}
            onclick={() => choose(entry.way)}
            class="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-(--wash-1)"
          >
            <span class="flex size-4 shrink-0 items-center justify-center {isOpen ? 'text-(--solus-status-running)' : 'text-foreground'}">
              {#if entry.way === "cloud"}<Cloud size={16} />{:else if entry.way === "pair"}<QrCode size={16} />{:else}<Terminal size={16} />{/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-workspace-chrome font-medium">{entry.title}</span>
              <span class="text-[0.8125rem] text-muted-foreground">{entry.detail}</span>
            </span>
            <ChevronRight size={15} class="shrink-0 text-foreground transition-transform duration-200 motion-reduce:transition-none {isOpen ? 'rotate-90' : ''}" />
          </button>
          {#if isOpen}
            <div class="border-t border-border/40 px-4 py-4">
              {#if entry.way === "cloud"}<AddCloudMachine />
              {:else if entry.way === "pair"}<AddPairMachine />{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>
</div>
