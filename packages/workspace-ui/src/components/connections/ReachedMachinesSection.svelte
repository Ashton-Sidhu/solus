<script lang="ts">
  /** The machines this host reaches as the owner (docs/plans/host-reach.md):
   *  each pairing with its health, and each introduction. Read-only: a person's
   *  machines reach each other with no step, and Forget on a machine's page is
   *  the way out. Shown to the host's local owner. */
  import { Monitor as MonitorIcon } from "@lucide/svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import ShowMoreRow from "../settings/ShowMoreRow.svelte";
  import { pageOf } from "../settings/lib/list-page";
  import { reachedMachinesStore as store } from "./reached-machines.store.svelte";
  import { isReachFailing, reachedMachineDetail, reachedMachines } from "@solus/client-core/reached-machines";

  let { serverId }: { serverId: string } = $props();
  let isExpanded = $state(false);

  $effect(() => store.watch(serverId));

  const introductions = $derived(store.introductionsByServer.get(serverId) ?? null);
  const machines = $derived(reachedMachines(store.pairingsByServer.get(serverId) ?? null, introductions, Date.now()));
  const page = $derived(pageOf(machines, isExpanded));
  const error = $derived(store.errorByServer.get(serverId));
</script>

<SettingsSection
  label="Machines it reaches"
  description="Your machines reach each other with no step. Agents here can start sessions on each of these."
>
  {#if error && !machines.length}
    <p role="alert" class="px-4 py-3.5 text-chrome-dense text-(--solus-status-error)">{error}</p>
  {:else if !introductions && !machines.length}
    <p class="px-4 py-6 text-center text-chrome-dense text-(--solus-text-tertiary)">Reading the machines it reaches…</p>
  {:else if !machines.length}
    <p class="px-4 py-6 text-center text-chrome-dense text-(--solus-text-tertiary)">It reaches no other machine yet. Add a machine, and your machines reach it too.</p>
  {:else}
    {#each page.rows as machine (machine.installationId)}
      <div class="flex items-center gap-3 px-4 py-2.5">
        <MonitorIcon size={16} class="shrink-0 text-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{machine.label}</p>
          <p
            class="truncate text-chrome-dense {isReachFailing(machine) ? 'text-(--solus-status-error)' : 'text-(--solus-text-tertiary)'}"
            title={machine.health?.kind === "failing" ? machine.health.detail : undefined}
          >{reachedMachineDetail(machine)}</p>
        </div>
      </div>
    {/each}
    <ShowMoreRow hiddenCount={page.hiddenCount} expanded={isExpanded} noun="machines" onToggle={() => (isExpanded = !isExpanded)} />
  {/if}
</SettingsSection>
