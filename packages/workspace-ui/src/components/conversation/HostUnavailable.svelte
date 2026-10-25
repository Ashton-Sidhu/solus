<script lang="ts">
  import { ChevronDown as ChevronIcon } from "@lucide/svelte";
  import {
    HOST_READINESS_ACTION_LABELS,
    hostReadinessCopy,
    isWaitingForHost,
    type HostReadinessAction,
  } from "@solus/client-core/host-readiness";
  import { hostDiagnosticRows, hostDiagnosticsText } from "@solus/client-core/host-diagnostics";
  import { getWorkspaceContext } from "../../contexts";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { copyText } from "../../lib/toasts";
  import { Button } from "../ui/button";

  /**
   * A conversation's host, when it is not ready (docs/plans/host-readiness.md).
   *
   * - `whisper`: inside the grace. One quiet line over the composer, which stays.
   * - `veil`: past the grace. The conversation sleeps under one statement of
   *   what happened and the one thing to do. The details to debug the host or
   *   send to support wait behind Details.
   */
  interface Props {
    serverId: string;
    variant: "whisper" | "veil";
  }

  let { serverId, variant }: Props = $props();

  const session = getWorkspaceContext();
  const readiness = $derived(serversStore.readinessFor(serverId));
  const label = $derived(serversStore.hostFor(serverId)?.label ?? "This host");
  const isWaiting = $derived(isWaitingForHost(readiness.readiness));

  // "Last seen 4 min ago" must not go stale while the host stays away.
  let now = $state(Date.now());
  $effect(() => {
    if (variant !== "veil") return;
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  const copy = $derived(hostReadinessCopy(readiness, label, now));

  let detailsOpen = $state(false);
  const rows = $derived(detailsOpen ? hostDiagnosticRows(serversStore.diagnosticsFor(serverId), now) : []);

  let copied = $state(false);
  async function copyDetails() {
    await copyText(hostDiagnosticsText(serversStore.diagnosticsFor(serverId)));
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  function openHostSettings() {
    session.showSettings("api-access", "click");
    connectionsNav.open(serverId);
  }

  function act(action: HostReadinessAction) {
    if (action === "retry") serversStore.retry(serverId);
    else if (action === "start") void serversStore.startManagedHost(serverId);
    else serversStore.openAddServer(serversStore.servers.find((server) => server.id === serverId)?.url ?? "");
  }
</script>

{#if variant === "whisper"}
  <p class="flex items-center justify-center gap-2 py-1.5 text-chrome-dense text-(--solus-text-tertiary)" role="status" data-testid="host-status-row">
    <span class="activity-spinner [--activity-icon-size:0.75rem]" aria-hidden="true"></span>
    {copy.headline}…
  </p>
{:else}
  <div class="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center" data-testid="host-unavailable">
    <!-- A halo in the page colour, so nothing in the sleeping transcript reads through the statement. -->
    <div
      class="flex w-full max-w-lg flex-col items-center gap-2 p-10 bg-[radial-gradient(closest-side,var(--color-background)_72%,transparent)]"
      role="status"
      aria-live="polite"
    >
      <h2 class="text-2xl font-medium tracking-tight text-balance text-(--solus-text-primary)">
        {isWaiting ? `Trying ${label} again…` : `${copy.headline}.`}
      </h2>
      {#if copy.detail && !isWaiting}
        <p class="text-workspace-chrome text-pretty text-(--solus-text-secondary)">{copy.detail}</p>
      {/if}

      <div class="mt-4 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          class="text-(--solus-text-secondary)"
          aria-expanded={detailsOpen}
          aria-controls="host-details-{serverId}"
          onclick={() => (detailsOpen = !detailsOpen)}
        >
          Details
          <ChevronIcon class="transition-transform duration-150 {detailsOpen ? 'rotate-180' : ''}" />
        </Button>
        {#if copy.action && !isWaiting}
          <Button size="sm" onclick={() => copy.action && act(copy.action)}>
            {HOST_READINESS_ACTION_LABELS[copy.action]}
          </Button>
        {/if}
      </div>

      {#if detailsOpen}
        <div id="host-details-{serverId}" class="mt-4 flex w-full flex-col gap-3 text-left">
          <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-chrome-dense">
            {#each rows as row (row.label)}
              <dt class="font-medium text-(--solus-text-primary)">{row.label}</dt>
              <dd class="min-w-0 break-words text-(--solus-text-secondary) select-text" class:font-mono={row.isCode}>{row.value}</dd>
            {/each}
          </dl>
          <div class="flex justify-center gap-1">
            <Button variant="ghost" size="sm" class="text-(--solus-text-secondary)" onclick={copyDetails}>{copied ? "Copied" : "Copy details"}</Button>
            <Button variant="ghost" size="sm" class="text-(--solus-text-secondary)" onclick={openHostSettings}>Host settings</Button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
