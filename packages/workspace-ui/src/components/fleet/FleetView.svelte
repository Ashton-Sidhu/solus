<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { CircleArrowUp, Pause, Plus, Radar, Radio, Search } from "@lucide/svelte";
  import { reachedMachines } from "@solus/client-core/reached-machines";
  import { isSessionBusyStatus } from "@solus/contracts/types";
  import { hostRoutesStore } from "../connections/host-routes.store.svelte";
  import { reachedMachinesStore, type ReachHost } from "../connections/reached-machines.store.svelte";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { runHost } from "../../contexts/workspace/run-location";
  import { toasts } from "../../lib/toasts";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import HostDirectory from "../servers/HostDirectory.svelte";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";
  import { Button } from "../ui/button";
  import * as Tooltip from "../ui/tooltip";
  import FleetAttention from "./FleetAttention.svelte";
  import FleetHostMenu from "./FleetHostMenu.svelte";
  import FleetMap from "./FleetMap.svelte";
  import FleetMapDetails from "./FleetMapDetails.svelte";
  import FleetMapFooter from "./FleetMapFooter.svelte";
  import FleetRouteTree from "./FleetRouteTree.svelte";
  import FleetLoad from "./FleetLoad.svelte";
  import FleetZoneDetail from "./FleetZoneDetail.svelte";
  import { askAgentAboutHosts } from "./ask-agent";
  import { discoverStore } from "./discover.store.svelte";
  import { fleetStore } from "./fleet.store.svelte";
  import { machineMatches, machinesByZone, ZONES, type FleetMachine, type FleetZoneId, type TileColorMode } from "./lib/fleet-model";
  import { foundStop } from "./lib/fleet-keys";
  import { introduceBlock, isTwoWay, reachEdgeId, reachEdges, type ReachEdge } from "./lib/fleet-reach";
  import { hostAskOf } from "./lib/host-agent";

  /**
   * Settings › Hosts: the summary, the map of how this device reaches every host,
   * which of your hosts reach each other, and the machines it found, and what needs
   * attention. List shows the same hosts as rows. On the map the person selects a
   * host or a line to see its details, picks several, and introduces hosts.
   */
  const workspace = getWorkspaceContext();

  let view = $state<"map" | "list">("map");
  let colorMode = $state<TileColorMode>("status");
  let query = $state("");
  let pointedId = $state<string | null>(null);
  let pointedFoundKey = $state<string | null>(null);
  let openZoneId = $state<FleetZoneId | null>(null);
  let selectedId = $state<string | null>(null);
  let selectedEdgeId = $state<string | null>(null);
  const pickedIds = new SvelteSet<string>();
  /** Which match of Find Enter goes to next. */
  let findIndex = $state(-1);
  let isIntroducing = $state(false);
  let fleetMap = $state<ReturnType<typeof FleetMap> | null>(null);
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
  const byId = $derived(new Map(machines.map((machine) => [machine.serverId, machine])));
  const focusId = $derived(pointedId);
  const focused = $derived(byId.get(focusId ?? "") ?? null);
  // A host or a line that left the map leaves the selection with it.
  const selected = $derived(byId.get(selectedId ?? "") ?? null);
  const picked = $derived(machines.filter((machine) => pickedIds.has(machine.serverId)));

  /** This device is the local owner of the host, so it reads the hosts that one reaches and may introduce it. */
  const isOwner = (serverId: string) => hosts.get(serverId).me.principal === "local-owner" && hosts.get(serverId).me.may("host.local.reach");
  const owned = $derived(machines.filter((machine) => (machine.zone === "own" || machine.zone === "device") && machine.state !== "unreachable" && isOwner(machine.serverId)));
  const ownedIds = $derived(owned.map((machine) => machine.serverId).join("\n"));
  const serverIdByInstallation = $derived(new Map(machines.flatMap((machine) => (machine.installationId ? [[machine.installationId, machine.serverId] as const] : []))));
  const edges = $derived(reachEdges(
    owned.map((machine) => ({
      serverId: machine.serverId,
      reached: reachedMachines(reachedMachinesStore.pairingsByServer.get(machine.serverId) ?? null, reachedMachinesStore.introductionsByServer.get(machine.serverId) ?? null, Date.now()),
    })),
    (installationId) => serverIdByInstallation.get(installationId),
  ));
  const selectedEdge = $derived(edges.find((edge) => edge.id === selectedEdgeId) ?? null);
  const blockOf = (serverId: string) => {
    const machine = byId.get(serverId);
    return machine ? introduceBlock(machine, isOwner(serverId)) : "This host is not on the map.";
  };
  const labelOf = (serverId: string) => byId.get(serverId)?.label ?? serverId;
  /** The hosts `serverId` can be introduced to now: those this device can introduce, which do not reach it both ways yet. */
  const candidatesFor = (serverId: string) => {
    const twoWay = new Set(edges.filter(isTwoWay).map((edge) => edge.id));
    return machines.filter((machine) => machine.serverId !== serverId && !blockOf(machine.serverId) && !twoWay.has(reachEdgeId(serverId, machine.serverId)));
  };
  const findMatches = $derived(query.trim() ? machines.filter((machine) => machineMatches(machine, query)) : []);
  /** The context menu of one host on the map, and where it opened. */
  let hostMenu = $state<{ serverId: string; x: number; y: number } | null>(null);
  const menuMachine = $derived(machines.find((machine) => machine.serverId === hostMenu?.serverId) ?? null);
  const pointedFound = $derived(discoverStore.found.find((machine) => machine.key === pointedFoundKey) ?? null);
  const openZone = $derived(ZONES.find((zone) => zone.id === openZoneId) ?? null);
  const withUpdate = $derived(machines.filter((machine) => machine.hasUpdate).map((machine) => machine.serverId));
  const matchCount = $derived(machines.filter((machine) => machineMatches(machine, query)).length);
  const foundCount = $derived(discoverStore.found.length);
  /** Motion and load reads run only while the map is seen. */
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

  // Which of your hosts reach each other is read for each host this device owns, while the map is seen.
  $effect(() => {
    if (view !== "map" || !ownedIds) return;
    const ids = ownedIds.split("\n");
    return untrack(() => {
      const stops = ids.map((serverId) => reachedMachinesStore.watch(serverId));
      return () => stops.forEach((stop) => stop());
    });
  });

  // The load of every host is read while the map is live, and not otherwise.
  $effect(() => {
    if (!isLive || !serverIds) return;
    const ids = serverIds.split("\n");
    return untrack(() => fleetStore.hold(ids));
  });

  /** The one fix of a host's problem (`hostReadinessCopy`). */
  function fix(machine: FleetMachine) {
    const action = machine.problem?.action;
    if (action === "retry") fleetStore.retryHosts([machine.serverId]);
    else if (action === "start") fleetStore.startHosts([machine.serverId]);
    else if (action === "pair-again") void serversStore.pairAgain(machine.serverId, machine.address ?? "");
  }

  /** A click or Enter on a host: Shift picks it for an introduction; a host already selected opens. */
  function activate(serverId: string, isAdding: boolean) {
    if (isAdding) {
      if (pickedIds.has(serverId)) pickedIds.delete(serverId);
      else pickedIds.add(serverId);
      return;
    }
    if (selectedId === serverId) {
      connectionsNav.open(serverId);
      return;
    }
    selectedEdgeId = null;
    selectedId = serverId;
  }

  function select(serverId: string | null) {
    selectedEdgeId = null;
    selectedId = serverId;
  }

  function selectEdge(edgeId: string) {
    selectedId = null;
    selectedEdgeId = edgeId;
  }

  function clearSelection() {
    selectedId = null;
    selectedEdgeId = null;
    pickedIds.clear();
  }

  function reachHost(serverId: string): ReachHost | null {
    const machine = byId.get(serverId);
    return machine?.installationId ? { serverId, installationId: machine.installationId, label: machine.label } : null;
  }

  /** Introduces `sourceId` to each target in turn; names what failed, and the hosts a drop had to skip. */
  async function introduce(sourceId: string, targetIds: string[], skipped: string[] = []) {
    const source = reachHost(sourceId);
    if (!source || isIntroducing) return;
    isIntroducing = true;
    const done: string[] = [];
    const failed: string[] = [];
    for (const targetId of targetIds) {
      const target = reachHost(targetId);
      if (!target) continue;
      try {
        await reachedMachinesStore.introduce(source, target);
        done.push(target.label);
      } catch (error) {
        failed.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    isIntroducing = false;
    pickedIds.clear();
    if (done.length) toasts.success(`Introduced ${source.label} to ${done.join(", ")}`, { description: "Agents on each can now start sessions on the other." });
    if (failed.length) toasts.error(`Could not introduce ${source.label}`, { description: failed.join("\n") });
    if (skipped.length) toasts.info("Some hosts were left out", { description: skipped.join("\n") });
  }

  async function forget(edge: ReachEdge) {
    const [a, b] = [reachHost(edge.a), reachHost(edge.b)];
    if (!a || !b || isIntroducing) return;
    isIntroducing = true;
    try {
      await reachedMachinesStore.forget(a, b, isOwner);
      selectedEdgeId = null;
      toasts.success(`${a.label} and ${b.label} no longer reach each other`, { description: "Introduce them again to undo this." });
    } catch (error) {
      toasts.error("Could not forget the introduction", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      isIntroducing = false;
    }
  }

  /** Enter in Find goes to the next match, Shift+Enter to the one before, centered on the map and selected. */
  function findNext(step: 1 | -1) {
    // From the start, Shift+Enter goes to the last match.
    findIndex = findIndex === -1 && step === -1 ? -1 : findIndex + step;
    const target = foundStop(findMatches, findIndex);
    if (target) fleetMap?.goTo(target.serverId);
  }

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
    <FleetLoad {machines} onOpen={(serverId) => connectionsNav.open(serverId)} onShowAll={() => (view = "list")} />

    <section class="flex flex-col gap-3">
      <div class="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 class="text-base font-medium tracking-[-0.01em] text-foreground">Map</h2>
        <div class="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Color tiles by">
          {#each [
            ["status", "Status", "Color host tiles by status"],
            ["cpu", "CPU", "Color host tiles by CPU usage"],
            ["sessions", "Sessions", "Color host tiles by the number of running sessions"],
          ] as const as [value, label, tooltip] (value)}
            <Tooltip.Root delayDuration={150}>
              <Tooltip.Trigger
                type="button"
                role="radio"
                aria-checked={colorMode === value}
                onclick={() => (colorMode = value)}
                class="inline-flex h-[1.625rem] items-center rounded-full px-2.5 text-[0.8125rem] text-muted-foreground hover:bg-(--wash-1) hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
              >{label}</Tooltip.Trigger>
              <Tooltip.Content value={tooltip} />
            </Tooltip.Root>
          {/each}
          <Tooltip.Root delayDuration={150}>
            <Tooltip.Trigger
              type="button"
              aria-pressed={!isPaused}
              aria-label={isPaused ? "Resume live updates" : "Pause live updates"}
              onclick={() => (isPaused = !isPaused)}
              class="grid size-[1.625rem] place-items-center rounded-full hover:bg-(--wash-1) {isLive ? 'text-(--success)' : 'text-muted-foreground hover:text-foreground'}"
            >{#if isLive}<Radio size={14} />{:else}<Pause size={14} />{/if}</Tooltip.Trigger>
            <Tooltip.Content value={isPaused ? "Resume live updates" : isLive ? "Pause live updates" : "Live updates pause when the map is out of view"} />
          </Tooltip.Root>
          <!-- Keep the scan control focusable so it can show the tooltip during a scan. -->
          <Tooltip.Root delayDuration={150}>
            <Tooltip.Trigger
              type="button"
              aria-disabled={discoverStore.isScanning}
              aria-label={discoverStore.isScanning ? "Scanning for machines" : "Scan for machines"}
              onclick={() => { if (!discoverStore.isScanning) void discoverStore.scan(); }}
              class="inline-flex h-[1.625rem] items-center gap-1.5 rounded-full px-2 text-[0.8125rem] text-muted-foreground tabular-nums hover:bg-(--wash-1) hover:text-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
            >
              <Radar size={14} class={discoverStore.isScanning ? "animate-pulse motion-reduce:animate-none" : ""} />
              {#if foundCount}{foundCount}{/if}
            </Tooltip.Trigger>
            <Tooltip.Content value={discoverStore.isScanning
              ? "Scanning the local network and Tailscale. Checking WSL and SSH settings."
              : `Scan for machines${foundCount ? ` · ${foundCount} found` : ""}`} />
          </Tooltip.Root>
        </div>
      </div>
      <label class="flex h-8 items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 text-muted-foreground focus-within:border-(--solus-status-running)/45">
        <Search size={14} />
        <input
          name="find-host"
          bind:value={query}
          oninput={() => (findIndex = -1)}
          onkeydown={(event) => {
            if (event.key !== "Enter" || view !== "map") return;
            event.preventDefault();
            findNext(event.shiftKey ? -1 : 1);
          }}
          placeholder="Find a host, organization, or system"
          aria-label="Find a host. Enter goes to the next match."
          class="min-w-0 flex-1 bg-transparent text-workspace-chrome text-foreground outline-none placeholder:text-muted-foreground max-sm:text-base"
        />
        {#if query.trim()}<span class="text-chrome-dense tabular-nums">{#if findIndex >= 0 && matchCount}{(((findIndex % matchCount) + matchCount) % matchCount) + 1} of {/if}{matchCount} found</span>{/if}
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
              bind:this={fleetMap}
              {machines}
              found={discoverStore.found}
              answers={fleetStore.answers}
              {colorMode}
              {query}
              {isLive}
              {edges}
              {pointedId}
              selectedId={selected?.serverId ?? null}
              {pickedIds}
              selectedEdgeId={selectedEdge?.id ?? null}
              routesOf={(serverId) => hostRoutesStore.statesFor(serverId)}
              {isOwner}
              onPoint={(serverId) => (pointedId = serverId)}
              onActivate={activate}
              onSelect={select}
              onPick={(serverIds) => serverIds.forEach((serverId) => pickedIds.add(serverId))}
              onClearSelection={clearSelection}
              onSelectEdge={selectEdge}
              onOpenZone={(zone) => (openZoneId = zone)}
              onAdd={(way) => connectionsNav.openAdd(way)}
              onStart={(serverId) => fleetStore.startHosts([serverId])}
              onPointFound={(key) => (pointedFoundKey = key)}
              onRetry={(zone) => fleetStore.retryZone(zone)}
              onIntroduce={(sourceId, targetIds, skipped) => void introduce(sourceId, targetIds, skipped)}
              onOpenMenu={(serverId, x, y) => (hostMenu = { serverId, x, y })}
            />
          </div>
          <div class="@min-[37.5rem]/fleet:hidden">
            <FleetRouteTree
              {machines}
              {colorMode}
              {query}
              {foundCount}
              answers={fleetStore.answers}
              onRetry={(zone) => fleetStore.retryZone(zone)}
              onPoint={(serverId) => (pointedId = serverId)}
              onOpen={(serverId) => connectionsNav.open(serverId)}
              onOpenZone={(zone) => (openZoneId = zone)}
              onAddFound={() => connectionsNav.openAdd("nearby")}
            />
          </div>
        {/if}
        {#if selected || selectedEdge || picked.length}
          <FleetMapDetails
            {selected}
            edge={selectedEdge}
            {picked}
            routes={selected ? hostRoutesStore.statesFor(selected.serverId) : []}
            reaches={selected ? edges.filter((edge) => edge.a === selected.serverId || edge.b === selected.serverId) : []}
            candidates={selected ? candidatesFor(selected.serverId) : []}
            canIntroduce={(serverId) => !blockOf(serverId)}
            {isOwner}
            {labelOf}
            isBusy={isIntroducing}
            onOpen={(serverId) => connectionsNav.open(serverId)}
            onFix={fix}
            onSelect={select}
            onSelectEdge={selectEdge}
            onIntroduce={(sourceId, targetIds) => void introduce(sourceId, targetIds)}
            onForget={(edge) => void forget(edge)}
            onClear={clearSelection}
          />
        {:else}
          <FleetMapFooter
            machine={focused}
            found={pointedFound}
            {colorMode}
            routes={focused ? hostRoutesStore.statesFor(focused.serverId) : []}
            onFix={fix}
          />
        {/if}
      </div>
    </section>

    {#if hostMenu && menuMachine}
      <FleetHostMenu
        x={hostMenu.x}
        y={hostMenu.y}
        machine={menuMachine}
        candidates={blockOf(menuMachine.serverId) ? [] : candidatesFor(menuMachine.serverId)}
        onIntroduce={(targetId) => void introduce(menuMachine.serverId, [targetId])}
        onAsk={() => askAgentAboutHosts(workspace, [menuMachine], hostAskOf(menuMachine))}
        onOpen={() => connectionsNav.open(menuMachine.serverId)}
        onNewSession={() => workspace.drafts.openSessionDraft({ freshTask: true, serverId: menuMachine.serverId, via: "click" })}
        onRetry={() => fleetStore.retryHosts([menuMachine.serverId])}
        onStart={() => fleetStore.startHosts([menuMachine.serverId])}
        onUpdate={() => fleetStore.updateHosts([menuMachine.serverId])}
        onRemove={() => serversStore.removeWithUndo(menuMachine.serverId)}
        onClose={() => (hostMenu = null)}
      />
    {/if}

    <FleetAttention
      {machines}
      onOpen={(serverId) => connectionsNav.open(serverId)}
      onAsk={(row) => askAgentAboutHosts(workspace, machines.filter((machine) => row.serverIds.includes(machine.serverId)), row.kind)}
      onPairAgain={(serverId) => { const machine = machines.find((entry) => entry.serverId === serverId); if (machine) fix(machine); }}
    />
  {/if}
</div>
