<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { linkMachines, machineLinkChoices, pairedHostRoute, type MachineLinkOutcome } from "@solus/client-core/host-linking";
  import { routeKindLabel } from "@solus/client-core/host-route-control";
  import { serversStore } from "../../contexts";
  import { MachineLinks } from "../../contexts/connections/machine-links.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";

  let { serverId }: { serverId?: string } = $props();
  let topology = $state<MachineLinks>();
  let selectedSource = $state("");
  let showPicker = $state(false);
  let busy = $state(false);
  let activeLink = $state("");
  let notice = $state("");
  const selected = new SvelteSet<string>();
  const outcomes = new SvelteMap<string, MachineLinkOutcome>();
  const machines = $derived([...(topology?.machines.values() ?? [])]);
  const sources = $derived(serverId ? [topology?.machines.get(serverId)].filter((machine) => !!machine) : machines);
  const source = $derived(selectedSource ? sources.find((machine) => machine.info.installationId === selectedSource) : sources[0]);
  const choices = $derived(source ? machineLinkChoices(source, machines) : []);
  const chosen = $derived(choices.filter((choice) => selected.has(choice.id) && outcomes.get(choice.id) !== "linked"));

  onMount(() => {
    const links = new MachineLinks();
    topology = links;
    return () => links.dispose();
  });

  function pickSource(id: string) {
    selectedSource = id;
    selected.clear();
    outcomes.clear();
  }

  async function apply() {
    if (!source || busy || !chosen.length) return;
    busy = true;
    notice = "";
    try {
      await linkMachines(source, chosen, (id, outcome) => {
        outcomes.set(id, outcome);
        if (outcome === "linked") selected.delete(id);
      });
      notice = [...outcomes.values()].some((outcome) => outcome === "failed")
        ? "Some links failed. The failed machines stay selected."
        : "Links added.";
    } finally { busy = false; }
  }

  async function connect(id: string, url: string) {
    activeLink = id;
    notice = "";
    try {
      await serversStore.pairAgain(id, url);
    } catch {
      notice = "Could not connect to this machine.";
    } finally { activeLink = ""; }
  }
</script>

{#if sources.length}
  <SettingsSection label="Machine links">
    {#each sources as machine (machine.info.installationId)}
      <div class="flex flex-col gap-2 px-4 py-3 text-workspace-chrome">
        {#if !serverId}<p class="font-medium">{machine.label}</p>{/if}
        {#if !machine.snapshot}
          <p class="text-muted-foreground">Machine links are unavailable.</p>
          <Button variant="ghost" size="sm" class="self-start" onclick={() => {
            const connection = serverId
              ? serverConnections.connectionFor(serverId)
              : serverConnections.serverIds().map((id) => serverConnections.connectionFor(id))
                .find((connection) => connection?.facts.value("serverInfo")?.installationId === machine.info.installationId);
            void connection?.pairings?.refresh();
          }}>Read links again</Button>
        {:else if !machine.snapshot.hosts.length}
          <p class="text-muted-foreground">No paired machines.</p>
        {:else}
          <ul class="flex flex-col divide-y divide-border">
            {#each machine.snapshot.hosts as pairing (pairing.listing.installationId)}
              {@const route = pairedHostRoute(pairing)}
              {@const id = pairing.listing.installationId}
              <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                <div class="min-w-0">
                  <p>{machine.label} → {pairing.listing.label}</p>
                  <p class="break-all text-chrome-dense text-muted-foreground">Owner access{route ? ` · ${routeKindLabel(route.kind)} · ${route.url}` : ""}</p>
                </div>
                <div class="flex gap-1">
                  {#if route && serversStore.readinessFor(id).readiness !== "ready"}
                    <Button variant="outline" size="sm" disabled={!!activeLink} onclick={() => void connect(id, route.url)}>Connect</Button>
                  {/if}
                  <Button variant="ghost" size="sm" disabled={!!activeLink || busy} aria-label="Unlink {pairing.listing.label} from {machine.label}" onclick={async () => {
                    if (!machine.isCurrent()) return;
                    activeLink = id;
                    notice = "";
                    try { await machine.api.hostsUnlink(id); }
                    catch { notice = "Could not remove this machine link."; }
                    finally { activeLink = ""; }
                  }}>Unlink</Button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
    <div class="flex flex-col gap-3 px-4 py-3 text-workspace-chrome">
      <Button variant="outline" size="sm" class="self-start" disabled={busy} onclick={() => {
        if (!showPicker && source) pickSource(source.info.installationId);
        else if (showPicker) pickSource("");
        showPicker = !showPicker;
      }}>
        {showPicker ? "Close link picker" : "Link machines…"}
      </Button>
      {#if showPicker && source}
        {#if sources.length > 1}
          <label class="flex flex-wrap items-center gap-2">Link from
            <select class="rounded-md border border-border bg-background px-2 py-1" value={source.info.installationId} disabled={busy} onchange={(event) => pickSource(event.currentTarget.value)}>
              {#each sources as machine (machine.info.installationId)}
                <option value={machine.info.installationId}>{machine.label}</option>
              {/each}
            </select>
          </label>
        {/if}
        <p class="text-muted-foreground">{source.label} will get owner access on each selected machine.</p>
        {#if !choices.length}
          <p class="text-muted-foreground">No other machine with a pairing route is available.</p>
        {:else}
          <fieldset class="flex flex-col gap-2" disabled={busy}>
            <legend class="sr-only">Machines to link</legend>
            {#each choices as choice (choice.id)}
              <label class="flex flex-wrap items-center gap-2">
                <input type="checkbox" checked={selected.has(choice.id)} onchange={(event) => event.currentTarget.checked ? selected.add(choice.id) : selected.delete(choice.id)} />
                {choice.label}
                <span class="text-chrome-dense text-muted-foreground">{routeKindLabel(choice.route.kind)} · {choice.route.url}{choice.viaLabel ? ` · via ${choice.viaLabel}` : ""}</span>
                {#if outcomes.get(choice.id) === "failed"}<span class="text-(--solus-status-error)">Link failed</span>{/if}
              </label>
            {/each}
          </fieldset>
          <Button size="sm" class="self-start" disabled={busy || !chosen.length} onclick={() => void apply()}>
            {busy ? "Linking…" : `Link ${chosen.length} ${chosen.length === 1 ? "machine" : "machines"}`}
          </Button>
        {/if}
      {/if}
      {#if showPicker && !source}<p role="status">Reconnect to the source machine to continue.</p>{/if}
      {#if notice}<p role="status">{notice}</p>{/if}
    </div>
  </SettingsSection>
{/if}
