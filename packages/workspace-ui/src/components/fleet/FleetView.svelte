<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { CircleArrowUp, Pause, Plus, Radar, Radio, Search } from "@lucide/svelte";
  import { isSessionBusyStatus } from "@solus/contracts/types";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { runHost } from "../../contexts/workspace/run-location";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import HostDirectory from "../servers/HostDirectory.svelte";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";
  import { Button } from "../ui/button";
  import FleetAttention from "./FleetAttention.svelte";
  import FleetHostMenu from "./FleetHostMenu.svelte";
  import FleetMap from "./FleetMap.svelte";
  import FleetMapFooter from "./FleetMapFooter.svelte";
  import FleetRouteTree from "./FleetRouteTree.svelte";
  import FleetSummary from "./FleetSummary.svelte";
  import FleetZoneDetail from "./FleetZoneDetail.svelte";
  import { askAgentAboutHosts } from "./ask-agent";
  import { discoverStore } from "./discover.store.svelte";
  import { fleetStore } from "./fleet.store.svelte";
  import { machineMatches, machinesByZone, ZONES, type FleetZoneId, type TileColorMode } from "./lib/fleet-model";
  import { hostAskOf } from "./lib/host-agent";

  /**
   * Settings › Hosts (docs/plans/host-fleet.md): the summary, the map of how this
   * device reaches every host and of the machines it found (D7), and what needs
   * attention. List shows the same hosts as rows.
   */
  const workspace = getWorkspaceContext();

  let view = $state<"map" | "list">("map");
  let colorMode = $state<TileColorMode>("status");
  let query = $state("");
  let pointedId = $state<string | null>(null);
  let pointedFoundKey = $state<string | null>(null);
  let openZoneId = $state<FleetZoneId | null>(null);
  let isPaused = $state(false);
  let isInView = $state(true);
  let isWindowVisible = $state(document.visibilityState === "visible");
  let root = $state<HTMLElement | null>(null);

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
  const focusId = $derived(pointedId);
  const focused = $derived(machines.find((machine) => machine.serverId === focusId) ?? null);
  /** The context menu of one host on the map (D12), and where it opened. */
  let hostMenu = $state<{ serverId: string; x: number; y: number } | null>(null);
  const menuMachine = $derived(machines.find((machine) => machine.serverId === hostMenu?.serverId) ?? null);
  const pointedFound = $derived(discoverStore.found.find((machine) => machine.key === pointedFoundKey) ?? null);
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

  /** A host on the map names itself with `data-host-id`. The menu key gives no pointer place, so the menu opens on the host. */
  function openHostMenu(event: MouseEvent) {
    const hostElement = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-host-id]") : null;
    const serverId = hostElement?.dataset.hostId;
    if (!hostElement || !serverId) return;
    event.preventDefault();
    const box = hostElement.getBoundingClientRect();
    const hasPointer = event.clientX !== 0 || event.clientY !== 0;
    hostMenu = { serverId, x: hasPointer ? event.clientX : box.left + box.width / 2, y: hasPointer ? event.clientY : box.bottom };
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
            aria-label={isPaused ? "Resume live updates" : "Pause live updates"}
            title={isLive ? "Live. Select to pause." : isPaused ? "Paused. Select to resume." : "Paused off screen"}
            onclick={() => (isPaused = !isPaused)}
            class="grid size-[1.625rem] place-items-center rounded-full hover:bg-(--wash-1) {isLive ? 'text-(--success)' : 'text-muted-foreground hover:text-foreground'}"
          >{#if isLive}<Radio size={14} />{:else}<Pause size={14} />{/if}</button>
          <!-- Discover (D7): the scan, and how many machines it found that are not added. -->
          <button
            type="button"
            disabled={discoverStore.isScanning}
            aria-label={discoverStore.isScanning ? "Scanning for machines" : "Scan for machines"}
            title={discoverStore.isScanning
              ? "Looking on your network, on Tailscale, on your Windows machines, and in your SSH config"
              : `${discoverStore.found.length} found and not added. Select to scan again.`}
            onclick={() => void discoverStore.scan()}
            class="inline-flex h-[1.625rem] items-center gap-1.5 rounded-full px-2 text-[0.8125rem] text-muted-foreground tabular-nums hover:bg-(--wash-1) hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <Radar size={14} class={discoverStore.isScanning ? "animate-pulse motion-reduce:animate-none" : ""} />
            {#if discoverStore.found.length}{discoverStore.found.length}{/if}
          </button>
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
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div oncontextmenu={openHostMenu} class="@container/fleet overflow-hidden rounded-xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none">
        {#if openZone}
          <FleetZoneDetail
            zone={openZone}
            machines={machinesByZone(machines)[openZone.id]}
            {colorMode}
            {query}
            {focusId}
            onPoint={(serverId) => (pointedId = serverId)}
            onOpen={(serverId) => connectionsNav.open(serverId)}
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
              {isLive}
              onPoint={(serverId) => (pointedId = serverId)}
              onOpen={(serverId) => connectionsNav.open(serverId)}
              onOpenZone={(zone) => (openZoneId = zone)}
              onAdd={(way) => connectionsNav.openAdd(way)}
              onStart={(serverId) => fleetStore.startHosts([serverId])}
              onPointFound={(key) => (pointedFoundKey = key)}
            />
          </div>
          <div class="@min-[37.5rem]/fleet:hidden">
            <FleetRouteTree
              {machines}
              {colorMode}
              {query}
              foundCount={discoverStore.found.length}
              onPoint={(serverId) => (pointedId = serverId)}
              onOpen={(serverId) => connectionsNav.open(serverId)}
              onOpenZone={(zone) => (openZoneId = zone)}
              onAddFound={() => connectionsNav.openAdd("nearby")}
            />
          </div>
        {/if}
        <FleetMapFooter machine={focused} found={pointedFound} {colorMode} />
      </div>
    </section>

    {#if hostMenu && menuMachine}
      <FleetHostMenu
        x={hostMenu.x}
        y={hostMenu.y}
        machine={menuMachine}
        onAsk={() => askAgentAboutHosts(workspace, [menuMachine], hostAskOf(menuMachine))}
        onOpen={() => connectionsNav.open(menuMachine.serverId)}
        onNewSession={() => workspace.drafts.openSessionDraft({ freshTask: true, serverId: menuMachine.serverId, via: "click" })}
        onRetry={() => fleetStore.retryHosts([menuMachine.serverId])}
        onStart={() => fleetStore.startHosts([menuMachine.serverId])}
        onUpdate={() => fleetStore.updateHosts([menuMachine.serverId])}
        onClose={() => (hostMenu = null)}
      />
    {/if}

    <FleetAttention
      {machines}
      onOpen={(serverId) => connectionsNav.open(serverId)}
      onAsk={(row) => askAgentAboutHosts(workspace, machines.filter((machine) => row.serverIds.includes(machine.serverId)), row.kind)}
    />
  {/if}
</div>
