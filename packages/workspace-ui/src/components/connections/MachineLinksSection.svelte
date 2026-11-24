<script lang="ts">
  /** The machine links of the owner connections (docs/host-pairing.md): each
   *  link once, a two-way link as one row, with how each direction is doing
   *  (state, expiry, last reach, addresses, the last error), and Connect, Link
   *  back, and Unlink. A machine whose links could not be read says so, with
   *  Retry. The section's action opens the dialog that links one machine to
   *  several others at once. On the Hosts page. */
  import { Link2 } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { machineLinksHiddenText, pairedHostRoute, type MachineLinkView } from "@solus/client-core/host-linking";
  import { serversStore } from "../../contexts";
  import type { MachineLinks } from "../../contexts/connections/machine-links.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import { linkDirections } from "./lib/machine-link-rows";

  interface Props {
    links: MachineLinks;
    views: MachineLinkView[];
    onLinkMachines: () => void;
    /** Opens Link machines from `sourceServerId` with the machine `targetId` selected. */
    onLinkBack: (sourceServerId: string, targetId: string) => void;
  }

  let { links, views, onLinkMachines, onLinkBack }: Props = $props();
  let activeLink = $state("");
  let notice = $state("");
  const machines = $derived([...links.machines.entries()].map(([serverId, machine]) => ({ serverId, machine })));
  /** The owner machines whose links could not be read: each has Retry. */
  const unread = $derived([...links.hidden.entries()].filter(([, reason]) => reason === "failed"));
  const serverIdOf = (installationId: string) => machines.find(({ machine }) => machine.info.installationId === installationId)?.serverId;

  async function connect(id: string, url: string) {
    activeLink = id;
    notice = "";
    try {
      await serversStore.pairAgain(id, url);
    } catch {
      notice = "Could not connect to this machine.";
    } finally { activeLink = ""; }
  }

  async function unlink(sourceId: string, targetId: string, targetLabel: string) {
    const machine = machines.find((entry) => entry.machine.info.installationId === sourceId)?.machine;
    if (!machine?.isCurrent()) return;
    activeLink = targetId;
    notice = "";
    try { await machine.api.hostsUnlink(targetId); }
    catch { notice = `Could not remove the link to ${targetLabel}.`; }
    finally { activeLink = ""; }
  }
</script>

{#if machines.length || unread.length}
  <SettingsSection label="Machine links">
    {#snippet action()}
      <Button variant="ghost" size="sm" class="-my-1 text-(--solus-text-tertiary) hover:text-(--solus-text-primary)" onclick={onLinkMachines}>
        <Link2 size={14} />
        Link machines
      </Button>
    {/snippet}
    {#if !views.length && !unread.length}
      <p class="px-4 py-3.5 text-chrome-dense text-(--solus-text-tertiary)">No machine links yet. Link machines to give one machine owner access on others.</p>
    {/if}
    {#if notice}<p role="status" class="px-4 py-2.5 text-chrome-dense text-(--solus-text-secondary)">{notice}</p>{/if}
    {#each unread as [serverId, reason] (serverId)}
      <div class="flex items-center justify-between gap-3 px-4 py-2.5">
        <p class="text-chrome-dense text-(--solus-text-tertiary)">{serversStore.hostFor(serverId)?.label ?? serverId}: {machineLinksHiddenText(reason)}</p>
        <Button variant="ghost" size="sm" onclick={() => void serverConnections.connectionFor(serverId)?.pairings?.refresh()}>Retry</Button>
      </div>
    {/each}
    {#each views as view (view.id)}
      {@const route = pairedHostRoute(view.pairing)}
      {@const directions = linkDirections(view, Date.now())}
      {@const backSourceServerId = view.canLinkBack ? serverIdOf(view.targetId) : undefined}
      <div class="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5">
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          {#if view.back}
            <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{view.sourceLabel} ↔ {view.targetLabel}</p>
          {/if}
          {#each directions as direction (direction.title)}
            <div class="min-w-0">
              <p class="flex min-w-0 items-center gap-2 {view.back ? 'text-chrome-dense text-(--solus-text-secondary)' : 'text-workspace-chrome font-medium text-(--solus-text-primary)'}">
                <span class="truncate">{direction.title}</span>
                <span
                  class="shrink-0 rounded bg-(--solus-surface-hover) px-1.5 text-chrome-dense font-normal {direction.state.kind === 'failing' || direction.state.kind === 'expired'
                    ? 'text-(--solus-status-error)'
                    : direction.state.kind === 'unreachable' || (direction.state.kind === 'reachable' && direction.state.expiresInDays !== null)
                      ? 'text-(--warning)'
                      : direction.state.kind === 'reachable'
                        ? 'text-(--success)'
                        : 'text-(--solus-text-tertiary)'}">{direction.stateText}</span>
              </p>
              <p class="text-chrome-dense text-(--solus-text-tertiary)">{direction.facts}</p>
              <p class="font-mono text-chrome-dense break-all text-(--solus-text-tertiary)">{direction.addresses.join(" · ")}</p>
              {#if direction.error}<p class="text-chrome-dense text-(--solus-status-error)">{direction.error}</p>{/if}
            </div>
          {/each}
        </div>
        <div class="flex shrink-0 gap-1">
          {#if route && serversStore.readinessFor(view.targetId).readiness !== "ready"}
            <Button variant="outline" size="sm" disabled={!!activeLink} onclick={() => void connect(view.targetId, route.url)}>Connect</Button>
          {/if}
          {#if backSourceServerId}
            <Button variant="ghost" size="sm" disabled={!!activeLink} title="Give {view.targetLabel} owner access on {view.sourceLabel} too" onclick={() => onLinkBack(backSourceServerId, view.sourceId)}>Link back</Button>
          {/if}
          <Button variant="ghost" size="sm" class="text-(--solus-text-tertiary) hover:text-(--solus-status-error)" disabled={!!activeLink} aria-label="Unlink {view.targetLabel} from {view.sourceLabel}" onclick={() => void unlink(view.sourceId, view.targetId, view.targetLabel)}>{view.back ? "Unlink →" : "Unlink"}</Button>
          {#if view.back}
            <Button variant="ghost" size="sm" class="text-(--solus-text-tertiary) hover:text-(--solus-status-error)" disabled={!!activeLink} aria-label="Unlink {view.sourceLabel} from {view.targetLabel}" onclick={() => void unlink(view.targetId, view.sourceId, view.sourceLabel)}>Unlink ←</Button>
          {/if}
        </div>
      </div>
    {/each}
  </SettingsSection>
{/if}
