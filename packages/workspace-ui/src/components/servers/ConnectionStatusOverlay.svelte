<script lang="ts">
  import { RotateCw as ArrowClockwiseIcon, WifiOff as WifiXIcon } from "@lucide/svelte";
  import { fly } from "svelte/transition";
  import {
    HOST_READINESS_ACTION_LABELS,
    hostReadinessCopy,
    type HostReadinessAction,
  } from "@solus/client-core/host-readiness";
  import { serversStore } from "../../contexts";
  import { connectionOverlayMode } from "./lib/connection-overlay";

  /**
   * The state of the host that serves this web window. Everything in the window
   * depends on it, so its state is the window's (docs/plans/host-readiness.md).
   * Content on another host shows that host's state where it is drawn.
   */
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const host = $derived(
    serversStore.servers.find((server) => server.id === serversStore.windowHostId) ?? null,
  );
  const readiness = $derived(host ? serversStore.readinessFor(host.id) : null);
  const mode = $derived(readiness ? connectionOverlayMode(readiness.readiness) : "hidden");
  const copy = $derived(readiness && host ? hostReadinessCopy(readiness, host.label) : null);

  function act(action: HostReadinessAction): void {
    if (!host) return;
    if (action === "retry") serversStore.retry(host.id);
    else if (action === "start") void serversStore.startManagedHost(host.id);
    else serversStore.openAddServer(host.url);
  }
</script>

{#if mode === "waiting" && host && copy}
  <div
    class="pointer-events-auto fixed left-1/2 top-3 z-[10018] flex -translate-x-1/2 items-center gap-2 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) py-1.5 pl-3 pr-2 text-xs font-secondary text-(--solus-text-secondary) shadow-(--solus-popover-shadow)"
    role="status"
    transition:fly={{ y: -8, duration: reduceMotion ? 0 : 260 }}
  >
    <WifiXIcon size={14} class="shrink-0 text-(--solus-accent)" />
    <span class="max-w-[16rem] truncate">{copy.headline}</span>
    <span class="h-3 w-px bg-(--solus-menu-hairline)"></span>
    <button
      type="button"
      class="flex items-center gap-1 rounded-full bg-(--solus-accent-soft) px-2 py-0.5 text-(--solus-accent) transition-colors hover:bg-(--solus-accent-light) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
      onclick={() => act("retry")}
    >
      <ArrowClockwiseIcon size={11} />
      {HOST_READINESS_ACTION_LABELS.retry}
    </button>
  </div>
{:else if mode === "card" && copy}
  <div
    class="pointer-events-auto fixed left-1/2 top-3 z-[10018] w-[19rem] -translate-x-1/2 rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-3.5 text-xs font-secondary shadow-(--solus-popover-shadow)"
    role="alert"
    transition:fly={{ y: -8, duration: reduceMotion ? 0 : 300 }}
  >
    <div class="text-sm text-(--solus-text-primary)">{copy.headline}</div>
    {#if copy.detail}
      <p class="mt-1 leading-relaxed text-(--solus-text-tertiary)">{copy.detail}</p>
    {/if}
    {#if copy.action}
      <button
        type="button"
        class="mt-3 rounded-md bg-(--solus-accent) px-2.5 py-1 text-white transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
        onclick={() => copy.action && act(copy.action)}
      >
        {HOST_READINESS_ACTION_LABELS[copy.action]}
      </button>
    {/if}
  </div>
{/if}
