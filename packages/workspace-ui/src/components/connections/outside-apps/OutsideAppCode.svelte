<script lang="ts">
  /** The code card of a cloud app's open row: the one-time code that approves
   *  the app on its sign-in page, for the access chosen. The row makes it when
   *  it opens and when the access changes; it counts down each second until it
   *  expires. The app it approves acts as the person who made it (plans/035 §0.3). */
  import { untrack } from "svelte";
  import type { AppAccess } from "@solus/contracts/host-api";
  import { connectionsStore } from "../../../contexts";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import { Button } from "../../ui/button";
  import { pairingCodeCountdown } from "../lib/outside-apps";
  import { outsideApps } from "./outside-apps.svelte";

  interface Props {
    serverId: string;
    access: AppAccess;
    appName: string;
  }

  let { serverId, access, appName }: Props = $props();

  const connections = connectionsStore;
  let now = $state(Date.now());
  let isCopied = $state(false);
  // A code for another access level is not this one: the row gets a new code.
  const hostCode = $derived(connections.appPairingCodeFor(serverId));
  const code = $derived(hostCode?.access === access ? hostCode : null);
  const codeError = $derived(connections.appPairingCodeErrorFor(serverId));
  const timeLeft = $derived(code ? pairingCodeCountdown(code.expiresAt, now) : null);

  $effect(() => {
    if (connections.appPairingCodeCreating || codeError || hostCode?.access === access) return;
    untrack(() => void connections.createAppPairingCode(serverId, access));
  });

  $effect(() => {
    if (!code) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  async function copy() {
    if (!code || !(await outsideApps.copy("code", code.code))) return;
    isCopied = true;
    setTimeout(() => (isCopied = false), 1500);
  }
</script>

<div class="flex min-w-0 flex-col gap-1.5 rounded-xl bg-(--solus-tx-card-bg) px-4 pt-3 pb-3.5 shadow-[shadow:var(--solus-card-shadow-collapsed)]" aria-live="polite">
  <div class="flex min-w-0 items-center justify-between gap-3">
    <span class="truncate text-[0.6875rem] leading-3.5 font-medium tracking-[0.08em] text-(--solus-text-tertiary) uppercase">Code for {appName}</span>
    {#if code && timeLeft}<span class="shrink-0 font-mono text-chrome-dense text-(--solus-text-tertiary) tabular-nums">{timeLeft}</span>{/if}
  </div>
  <div class="flex min-w-0 items-center justify-between gap-3">
    {#if code && timeLeft}
      <span class="truncate font-mono text-[1.375rem] leading-7 font-medium tracking-[0.08em] text-(--solus-text-primary) tabular-nums select-text">{code.code}</span>
      <Button variant="ghost" size="sm" class="shrink-0 bg-muted" onclick={() => void copy()}>{isCopied ? "Copied" : "Copy"}</Button>
    {:else if codeError}
      <span role="alert" class="text-chrome-dense text-(--solus-status-error)">{codeError}</span>
      <Button variant="ghost" size="sm" class="shrink-0 bg-muted" disabled={connections.appPairingCodeCreating} onclick={() => void connections.createAppPairingCode(serverId, access)}>Try again</Button>
    {:else if code}
      <span class="text-workspace-chrome text-(--solus-text-secondary)">The code expired.</span>
      <Button variant="ghost" size="sm" class="shrink-0 bg-muted" disabled={connections.appPairingCodeCreating} onclick={() => void connections.createAppPairingCode(serverId, access)}>New code</Button>
    {:else}
      <span class="text-workspace-chrome text-(--solus-text-tertiary)">Getting a code…</span>
    {/if}
  </div>
</div>
