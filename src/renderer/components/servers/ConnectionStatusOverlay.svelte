<script lang="ts">
  import { ArrowClockwiseIcon, CheckIcon, WifiXIcon } from "phosphor-svelte";
  import { fly } from "svelte/transition";
  import { formatElapsed } from "@client-core/connection-display";
  import { serversStore } from "../../contexts";
  import { connectionOverlayMode } from "./lib/connection-overlay";
  import { liveActivityClock } from "../../lib/shared-clock";

  /**
   * The pill window is a transparent, click-through canvas over the desktop, so
   * a stale scrim there would wash out whatever the user is actually looking at.
   */
  let { dimBackdrop = false }: { dimBackdrop?: boolean } = $props();

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const host = $derived(serversStore.activeServer);
  const isRemote = $derived(!!host && !host.local);

  /**
   * A counter that only advances while it means something. Ticking every second
   * for the whole session would invalidate every reader of this component.
   */
  let now = $state(Date.now());
  $effect(() => {
    if (!serversStore.offlineSince) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const mode = $derived(
    connectionOverlayMode({
      status: serversStore.connectionStatus,
      offlineSince: serversStore.offlineSince,
      now,
      isRemote,
    }),
  );

  const elapsed = $derived(
    serversStore.offlineSince
      ? formatElapsed(now - serversStore.offlineSince)
      : "",
  );

  /**
   * App mount does not wait on the socket, so this overlay covers a slow first
   * connect as well as a drop. They are the same shape but not the same event —
   * nothing has been lost yet on a first connect.
   */
  const verb = $derived(
    serversStore.hasConnected ? "reconnecting" : "connecting",
  );

  /**
   * Confirming recovery closes the loop the pill opened. Leaving it up would
   * turn a resolved problem into permanent chrome, so it retires itself.
   */
  let confirmingReconnect = $state(false);
  $effect(() => {
    if (!serversStore.lastReconnectAt) return;
    confirmingReconnect = true;
    const timer = setTimeout(() => (confirmingReconnect = false), 3200);
    return () => clearTimeout(timer);
  });
  const cardCopy = $derived(
    mode === "identity-mismatch"
      ? {
          title: "Different server than expected",
          body: `The address saved for ${host?.label} answered as another Solus server. Pair again only if you intend to replace the saved host.`,
          primary: "Pair this server",
        }
      : mode === "blocked"
      ? {
          title: `${host?.label} needs pairing again`,
          body: "The saved session token was rejected. Your work is safe — pair with this host again to keep going.",
          primary: "Pair again",
        }
      : {
          title: `Still trying to reach ${host?.label}`,
          body: `No answer for ${elapsed}. Anything you send is queued and will deliver as soon as it answers.`,
          primary: "Retry now",
        },
  );

  function runPrimary(): void {
    if (mode === "blocked" || mode === "identity-mismatch") serversStore.openAddServer(host?.url ?? "");
    else serversStore.retryActive();
  }
</script>

{#if dimBackdrop && (mode === "reconnecting" || mode === "escalated" || mode === "blocked" || mode === "identity-mismatch")}
  <!--
    Stale panes stay readable but stop reading as live. Purely decorative: it
    never swallows a click, so the user can keep navigating what they already
    have while the socket comes back.
  -->
  <div
    class="pointer-events-none fixed inset-0 z-[10016] bg-(--solus-edge-bg) opacity-35 transition-opacity duration-500"
    aria-hidden="true"
  ></div>
  {#if mode !== "blocked" && mode !== "identity-mismatch"}
    <div
      class="connection-hairline pointer-events-none fixed inset-x-0 top-0 z-[10017] h-0.5 overflow-hidden"
      aria-hidden="true"
    ></div>
  {/if}
{/if}

{#if mode === "reconnecting"}
  <div
    class="pointer-events-auto fixed left-1/2 top-3 z-[10018] flex -translate-x-1/2 items-center gap-2 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) py-1.5 pl-3 pr-2 text-xs font-secondary text-(--solus-text-secondary) shadow-(--solus-popover-shadow) backdrop-blur-xl"
    role="status"
    transition:fly={{ y: -8, duration: reduceMotion ? 0 : 260 }}
  >
    <WifiXIcon size={14} class="shrink-0 text-(--solus-accent)" />
    <span class="max-w-[14rem] truncate">
      <span class="text-(--solus-text-primary)">{host?.label}</span>
      {verb}
    </span>
    <span class="tabular-nums text-(--solus-text-tertiary)">{elapsed}</span>
    <span class="h-3 w-px bg-(--solus-menu-hairline)"></span>
    <button
      type="button"
      class="flex items-center gap-1 rounded-full bg-(--solus-accent-soft) px-2 py-0.5 text-xs text-(--solus-accent) transition-colors hover:bg-(--solus-accent-light) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
      onclick={() => serversStore.retryActive()}
    >
      <ArrowClockwiseIcon size={11} />
      Retry now
    </button>
  </div>
{:else if mode === "escalated" || mode === "blocked" || mode === "identity-mismatch"}
  <div
    class="pointer-events-auto fixed left-1/2 top-3 z-[10018] w-[19rem] -translate-x-1/2 rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-3.5 font-secondary shadow-(--solus-popover-shadow) backdrop-blur-xl"
    role="alert"
    transition:fly={{ y: -8, duration: reduceMotion ? 0 : 300 }}
  >
    <div class="text-[0.8125rem] text-(--solus-text-primary)">{cardCopy.title}</div>
    <p class="mt-1 text-xs leading-relaxed text-(--solus-text-tertiary)">
      {cardCopy.body}
    </p>
    <div class="mt-3 flex gap-2">
      <button
        type="button"
        class="rounded-md bg-(--solus-accent) px-2.5 py-1 text-xs text-white transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
        onclick={runPrimary}
      >
        {cardCopy.primary}
      </button>
      <button
        type="button"
        class="rounded-md border border-(--solus-input-border) px-2.5 py-1 text-xs text-(--solus-text-secondary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
        onclick={() => serversStore.useLocalHost()}
      >
        Use this Mac
      </button>
    </div>
  </div>
{:else if confirmingReconnect}
  <div
    class="pointer-events-none fixed left-1/2 top-3 z-[10018] flex -translate-x-1/2 items-center gap-2 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) px-3 py-1.5 text-xs font-secondary text-(--solus-text-secondary) shadow-(--solus-popover-shadow) backdrop-blur-xl"
    role="status"
    transition:fly={{ y: -8, duration: reduceMotion ? 0 : 260 }}
  >
    <CheckIcon size={13} class="shrink-0 text-(--solus-status-live)" />
    <span>
      <span class="text-(--solus-status-live)">Reconnected</span> to {host?.label}
    </span>
  </div>
{/if}

<style>
  /*
    A sweep rather than a spinner: it reads as the app still working on your
    behalf without claiming to know how far along the retry is.
  */
  .connection-hairline::after {
    content: "";
    position: absolute;
    inset-block: 0;
    left: -38%;
    width: 38%;
    background: linear-gradient(
      90deg,
      transparent,
      var(--solus-accent),
      transparent
    );
    animation: connection-sweep 1.5s ease-in-out infinite;
  }

  @keyframes connection-sweep {
    to {
      left: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .connection-hairline::after {
      animation: none;
      left: 0;
      width: 100%;
      opacity: 0.4;
    }
  }
</style>
