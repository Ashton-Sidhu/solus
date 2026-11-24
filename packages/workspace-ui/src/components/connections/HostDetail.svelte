<script lang="ts">
  import { untrack } from "svelte";
  import { connectionsNav } from "./connections-nav.svelte";
  /** One host, in full. The onboarding rail is for arrival and asks one thing
   *  at a time; this is where a host set up last week can be looked at, and
   *  every part of it changed, in whatever order the user wants. */
  import { Plus, Power, RotateCw } from "@lucide/svelte";
  import { isSessionBusyStatus } from "@solus/contracts/types";
  import { getWorkspaceContext, managedHostsStore, serversStore, uplinkStore, type ServerItem } from "../../contexts";
  import { runHost } from "../../contexts/workspace/run-location";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import { Button } from "../ui/button";
  import FleetLoadRing from "../fleet/FleetLoadRing.svelte";
  import HostGlance from "../fleet/HostGlance.svelte";
  import HostStateIcon from "../fleet/HostStateIcon.svelte";
  import { fleetStore } from "../fleet/fleet.store.svelte";
  import { hostKindLabel, toneOf } from "../fleet/lib/fleet-model";
  import * as Tabs from "../ui/tabs";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";
  import HostDetailOverview from "./HostDetailOverview.svelte";
  import HostDetailGit from "./HostDetailGit.svelte";
  import HostDetailProviders from "./HostDetailProviders.svelte";
  import HostDetailEnvironment from "./HostDetailEnvironment.svelte";
  import HostDetailAccess from "./HostDetailAccess.svelte";
  import HostRoutesSection from "./HostRoutesSection.svelte";

  interface Props {
    host: ServerItem;
  }

  let { host }: Props = $props();

  const setup = $derived(hostSetupStore.sessionFor(host.id));
  const workspace = getWorkspaceContext();

  // A host is a host (docs/plans/host-fleet.md D2): every kind gets this header and these numbers.
  const busySessions = $derived(
    Object.values(workspace.sessions.byId).filter((session) => runHost(session.run) === host.id && isSessionBusyStatus(session.status)).length,
  );
  const machine = $derived(
    fleetStore.machineOf(host, busySessions, new Map(serversStore.organizations.map((organization) => [organization.organizationId, organization.name]))),
  );
  const busyAction = $derived(managedHostsStore.busy?.serverId === host.id ? managedHostsStore.busy.action : null);

  // The page reads this host's load while it is open.
  $effect(() => {
    const serverId = host.id;
    return untrack(() => fleetStore.hold([serverId]));
  });

  function newSession() {
    workspace.drafts.openSessionDraft({ freshTask: true, serverId: host.id, via: "click" });
  }

  // Setup events belong to the host, so the page holds its subscription open
  // for as long as it is showing that host — and hands it back on the way out.
  $effect(() => {
    const serverId = host.id;
    return untrack(() => {
      const session = hostSetupStore.sessionFor(serverId);
      session.retain();
      void session.refreshReadiness();
      void uplinkStore.refresh(serverId);
      return () => session.release();
    });
  });

  // What the host is, in its own terms: where it answers and what it runs.
  const meta = $derived(
    [host.url, setup.readiness?.platform].filter(Boolean).join(" · "),
  );
</script>

<div class="flex flex-col gap-6">
  <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
    <div class="flex min-w-0 items-center gap-3.5">
      <FleetLoadRing cpu={machine.cpu} tone={toneOf(machine.state)} size={48}>
        <HostOperatingSystemIcon os={host.os} managed={machine.isManaged} size={18} class="text-foreground" />
      </FleetLoadRing>
      <div class="flex min-w-0 flex-col gap-1.5">
        <h1 class="flex min-w-0 items-center gap-2.5 text-[1.375rem] font-medium tracking-[-0.01em] text-foreground">
          <span class="truncate">{host.label}</span>
          <HostStateIcon state={machine.state} count={machine.state === "running" ? machine.sessions : undefined} size={15} />
          {#if machine.needsSetup}<HostStateIcon state="signin" size={15} />{/if}
          {#if machine.hasUpdate}<HostStateIcon state="update" size={15} />{/if}
        </h1>
        <p class="flex min-w-0 flex-wrap items-center gap-1.5">
          <span class="inline-flex h-[1.1875rem] items-center rounded-md bg-(--wash-3) px-[7px] text-chrome-dense text-(--solus-text-secondary)">{hostKindLabel(machine)}</span>
          <span class="min-w-0 truncate font-mono text-chrome-dense text-muted-foreground">{meta}</span>
        </p>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      {#if machine.isManaged}
        {#if machine.state === "stopped"}
          <Button variant="outline" size="sm" disabled={!!busyAction} onclick={() => void managedHostsStore.start(host.id)}><Power size={14} />{busyAction === "start" ? "Starting…" : "Start"}</Button>
        {:else}
          <Button variant="ghost" size="sm" disabled={!!busyAction} onclick={() => void managedHostsStore.restart(host.id)}><RotateCw size={14} />{busyAction === "restart" ? "Restarting…" : "Restart"}</Button>
          <Button variant="outline" size="sm" disabled={!!busyAction} onclick={() => void managedHostsStore.stop(host.id)}><Power size={14} />{busyAction === "stop" ? "Stopping…" : "Stop"}</Button>
        {/if}
      {/if}
      <Button size="sm" disabled={machine.state !== "running" && machine.state !== "idle"} onclick={newSession}><Plus size={14} />New session</Button>
    </div>
  </div>

  <HostGlance {machine} load={fleetStore.loads.get(host.id)} />

  <Tabs.Root bind:value={connectionsNav.tab}>
    <!-- The active tab colors its own segment of the list's hairline: same
         thickness, same place, so the divider reads as one line. -->
    <Tabs.List variant="line" class="w-full justify-start gap-5 border-b border-border p-0 group-data-horizontal/tabs:h-auto">
      {#each [["overview", "Overview"], ["resources", "Resources"], ["access", "Access"], ["git", "Git"], ["providers", "AI providers"], ["environment", "Environment"]] as [value, label] (value)}
        <Tabs.Trigger {value} class="h-auto flex-none rounded-none px-0 pt-0 pb-2.5 text-workspace-chrome group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] group-data-[orientation=horizontal]/tabs:after:h-px data-active:text-foreground">{label}</Tabs.Trigger>
      {/each}
    </Tabs.List>

    <Tabs.Content value="overview" class="mt-5 flex flex-col gap-7">
      <HostRoutesSection serverId={host.id} />
      <HostDetailOverview {host} {setup} onOpenTab={(next) => (connectionsNav.tab = next)} />
    </Tabs.Content>
    <!-- Mounted only while selected: the tab holds the watch that makes the host sample. -->
    {#if connectionsNav.tab === "resources"}
      <Tabs.Content value="resources" class="mt-5 flex flex-col gap-7">
        {#await import("./HostDetailResources.svelte") then { default: HostDetailResources }}
          <HostDetailResources serverId={host.id} />
        {/await}
      </Tabs.Content>
    {/if}
    <!-- Room below the last card: the page ends with space, not on the window's edge. -->
    <Tabs.Content value="access" class="mt-5 flex flex-col gap-7 pb-16">
      <HostDetailAccess serverId={host.id} />
    </Tabs.Content>
    <Tabs.Content value="git" class="mt-5 flex flex-col gap-7">
      <HostDetailGit {setup} />
    </Tabs.Content>
    <Tabs.Content value="providers" class="mt-5 flex flex-col gap-7">
      <HostDetailProviders {setup} />
    </Tabs.Content>
    <Tabs.Content value="environment" class="mt-5 flex flex-col gap-7">
      <HostDetailEnvironment {setup} serverId={host.id} />
    </Tabs.Content>
  </Tabs.Root>
</div>
