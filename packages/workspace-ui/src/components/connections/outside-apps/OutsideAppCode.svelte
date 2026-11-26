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

<div class="flex min-w-0 items-center justify-between gap-3 rounded-[0.625rem] bg-(--solus-code-bg) px-3.5 py-3 ring-1 ring-border" aria-live="polite">
  <div class="flex min-w-0 flex-col gap-0.75">
    <span class="text-chrome-dense text-(--solus-text-tertiary)">When {appName} asks for a code</span>
    {#if code && timeLeft}
      <span class="truncate text-[1.375rem] leading-7 font-semibold tracking-[0.06em] text-(--solus-text-primary) tabular-nums select-text">{code.code}</span>
    {:else if codeError}
      <span role="alert" class="text-chrome-dense text-(--solus-status-error)">{codeError}</span>
    {:else if code}
      <span class="text-workspace-chrome text-(--solus-text-secondary)">The code expired.</span>
    {:else}
      <span class="text-workspace-chrome text-(--solus-text-tertiary)">Getting a code…</span>
    {/if}
  </div>
  <div class="flex shrink-0 flex-col items-end gap-0.75">
    {#if code && timeLeft}
      <Button variant="ghost" size="xs" class="-mr-2 text-[0.8125rem] text-primary hover:text-primary" onclick={() => void copy()}>
        {isCopied ? "Copied" : "Copy"}
      </Button>
      <span class="text-chrome-dense text-(--solus-text-tertiary) tabular-nums">{timeLeft}</span>
    {:else if code || codeError}
      <Button variant="outline" size="sm" disabled={connections.appPairingCodeCreating} onclick={() => void connections.createAppPairingCode(serverId, access)}>
        {codeError ? "Try again" : "New code"}
      </Button>
    {/if}
  </div>
</div>
