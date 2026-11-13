<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { CircleArrowUp, Plus, Search } from "@lucide/svelte";
  import { isSessionBusyStatus } from "@solus/contracts/types";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { runHost } from "../../contexts/workspace/run-location";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import HostDirectory from "../servers/HostDirectory.svelte";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";
  import { Button } from "../ui/button";
  import FleetAttention from "./FleetAttention.svelte";
  import FleetDiscover from "./FleetDiscover.svelte";
  import FleetMap from "./FleetMap.svelte";
  import FleetMapFooter from "./FleetMapFooter.svelte";
  import FleetRouteTree from "./FleetRouteTree.svelte";
  import FleetSummary from "./FleetSummary.svelte";
  import FleetZoneDetail from "./FleetZoneDetail.svelte";
  import { discoverStore } from "./discover.store.svelte";
  import { fleetStore } from "./fleet.store.svelte";
  import { machineMatches, machinesByZone, ZONES, type FleetZoneId, type TileColorMode } from "./lib/fleet-model";

  /**
   * Settings › Hosts (docs/plans/host-fleet.md): the summary, the map of how this
   * device reaches every host, Discover, and what needs attention. List shows the
   * same hosts as rows.
   */
  const workspace = getWorkspaceContext();

  let view = $state<"map" | "list">("map");
  let colorMode = $state<TileColorMode>("status");
  let query = $state("");
  let pointedId = $state<string | null>(null);
  let selectedId = $state<string | null>(null);
  let openZoneId = $state<FleetZoneId | null>(null);
  let isPaused = $state(false);
  let isInView = $state(true);
  let isWindowVisible = $state(document.visibilityState === "visible");
  let root = $state<HTMLElement | null>(null);
  let discover = $state<HTMLElement | null>(null);

  // Sessions working on each host: only the workspace knows them.
  const busyByHost = $derived.by(() => {
    const busy = new Map<string, number>();
    for (const session of Object.values(workspace.sessions.byId)) {
      if (!isSessionBusyStatus(session.status)) continue;
      const serverId = runHost(session.run);
      busy.set(serverId, (busy.get(serverId) ?? 0) + 1);
    }
    return busy;
  });
  const machines = $derived(fleetStore.machines(busyByHost));
  const focusId = $derived(pointedId ?? selectedId);
  const focused = $derived(machines.find((machine) => machine.serverId === focusId) ?? null);
  const openZone = $derived(ZONES.find((zone) => zone.id === openZoneId) ?? null);
  const withUpdate = $derived(machines.filter((machine) => machine.hasUpdate).map((machine) => machine.serverId));
  const matchCount = $derived(machines.filter((machine) => machineMatches(machine, query)).length);
  /** Motion and load reads run only while the map is seen (D5, D6). */
  const isLive = $derived(view === "map" && isInView && isWindowVisible && !isPaused);
  const serverIds = $derived(machines.map((machine) => machine.serverId).join("\n"));

  onMount(() => {
    // Opening Hosts is one of the directory's refresh points (C1).
    void serversStore.refreshDirectory();
    void hostSetupStore.probeUnprobedOnline(serversStore.executionServers);
    const stopDiscover = discoverStore.watch();
    const observer = new IntersectionObserver(([entry]) => (isInView = entry?.isIntersecting ?? true), { threshold: 0.05 });
    if (root) observer.observe(root);
    const onVisibility = () => (isWindowVisible = document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopDiscover();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  // The load of every host is read while the map is live, and not otherwise.
  $effect(() => {
    if (!isLive || !serverIds) return;
    const ids = serverIds.split("\n");
    return untrack(() => fleetStore.hold(ids));
  });

  function select(serverId: string) {
    selectedId = selectedId === serverId ? null : serverId;
  }
</script>

<div bind:this={root} class="flex flex-col gap-10">
  <div class="flex flex-col gap-4">
    <p class="max-w-xl text-[0.8125rem] text-pretty text-(--solus-text-secondary)">Every machine your agents can run on, and how this device reaches it.</p>
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div class="flex gap-1" role="tablist" aria-label="View">
        {#each [["map", "Map"], ["list", "List"]] as const as [value, label] (value)}
          <button
            type="button"
            role="tab"
            aria-selected={view === value}
            onclick={() => (view = value)}
            class="inline-flex h-[1.625rem] items-center rounded-full px-2.5 text-workspace-chrome text-muted-foreground hover:bg-(--wash-1) hover:text-foreground aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
          >{label}</button>
        {/each}
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        {#if withUpdate.length}
          <Button variant="ghost" size="sm" onclick={() => fleetStore.updateHosts(withUpdate)}><CircleArrowUp size={14} />Update {withUpdate.length}</Button>
        {/if}
        <Button size="sm" onclick={() => connectionsNav.openAdd()}><Plus size={14} />Add machine</Button>
      </div>
    </div>
  </div>

  {#if view === "list"}
    <HostDirectory />
  {:else}
    <FleetSummary {machines} />

    <section class="flex flex-col gap-3">
      <div class="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 class="text-base font-medium tracking-[-0.01em] text-foreground">Map</h2>
        <div class="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Color tiles by">
          {#each [["status", "Status"], ["cpu", "CPU"], ["sessions", "Sessions"]] as const as [value, label] (value)}
            <button
              type="button"
              role="radio"
              aria-checked={colorMode === value}
              onclick={() => (colorMode = value)}
              class="inline-flex h-[1.625rem] items-center rounded-full px-2.5 text-[0.8125rem] text-muted-foreground hover:bg-(--wash-1) hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
            >{label}</button>
          {/each}
          <button
            type="button"
            aria-pressed={!isPaused}
            title={isPaused ? "Resume live updates" : "Pause live updates"}
            onclick={() => (isPaused = !isPaused)}
            class="inline-flex h-[1.625rem] items-center rounded-full px-2.5 text-[0.8125rem] hover:bg-(--wash-1) {isLive ? 'text-(--success)' : 'text-muted-foreground'}"
          >{isLive ? "Live" : isPaused ? "Paused" : "Paused off screen"}</button>
        </div>
      </div>
      <label class="flex h-8 items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 text-muted-foreground focus-within:border-(--solus-status-running)/45">
        <Search size={14} />
        <input
          name="find-host"
          bind:value={query}
          placeholder="Find a host, organization, or system"
          aria-label="Find a host"
          class="min-w-0 flex-1 bg-transparent text-workspace-chrome text-foreground outline-none placeholder:text-muted-foreground max-sm:text-base"
        />
        {#if query.trim()}<span class="text-chrome-dense tabular-nums">{matchCount} found</span>{/if}
      </label>

      <!-- The map below 37.5rem of its own width is a tree of the same routes: one rule, in CSS. -->
      <div class="@container/fleet overflow-hidden rounded-xl border border-border/50 bg-background">
        {#if openZone}
          <FleetZoneDetail
            zone={openZone}
            machines={machinesByZone(machines)[openZone.id]}
            {colorMode}
            {query}
            {focusId}
            onPoint={(serverId) => (pointedId = serverId)}
            onSelect={select}
            onBack={() => (openZoneId = null)}
          />
        {:else}
          <div class="@max-[37.5rem]/fleet:hidden">
            <FleetMap
              {machines}
              found={discoverStore.found}
              {colorMode}
              {query}
              {focusId}
              {selectedId}
              {isLive}
              onPoint={(serverId) => (pointedId = serverId)}
              onSelect={select}
              onOpenZone={(zone) => (openZoneId = zone)}
              onAdd={(way) => connectionsNav.openAdd(way)}
              onStart={(serverId) => fleetStore.startHosts([serverId])}
              onShowFound={() => discover?.scrollIntoView({ behavior: "smooth", block: "start" })}
            />
          </div>
          <div class="@min-[37.5rem]/fleet:hidden">
            <FleetRouteTree
              {machines}
              {colorMode}
              {query}
              {selectedId}
              onPoint={(serverId) => (pointedId = serverId)}
              onSelect={select}
              onOpenZone={(zone) => (openZoneId = zone)}
            />
          </div>
        {/if}
        <FleetMapFooter machine={focused} {colorMode} onOpen={(serverId) => connectionsNav.open(serverId)} />
      </div>
    </section>

    <div bind:this={discover} class="scroll-mt-6">
      <FleetDiscover />
    </div>

    <FleetAttention {machines} onOpen={(serverId) => connectionsNav.open(serverId)} />
  {/if}
</div>
