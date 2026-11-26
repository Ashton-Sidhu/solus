<script lang="ts">
  /** The pairing code that approves an app on its sign-in page, for the access
   *  chosen. It is made only when the person asks ("Get code"), it is never
   *  copied by itself, and it counts down each second until it expires. The app
   *  it approves acts as the person who made it (plans/035 §0.3). */
  import type { AppAccess } from "@solus/contracts/host-api";
  import { connectionsStore } from "../../../contexts";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import { Button } from "../../ui/button";
  import { appAccessLabel } from "../lib/paired-devices";
  import { pairingCodeCountdown } from "../lib/outside-apps";
  import OutsideAppsCopyRow from "./OutsideAppsCopyRow.svelte";

  interface Props {
    serverId: string;
    access: AppAccess;
  }

  let { serverId, access }: Props = $props();

  const connections = connectionsStore;
  let now = $state(Date.now());
  // A code for another access level is not this one: the person gets a new code.
  const code = $derived(connections.appPairingCode?.access === access ? connections.appPairingCode : null);
  const countdown = $derived(code ? pairingCodeCountdown(code.expiresAt, now) : null);

  $effect(() => {
    if (!code) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });
</script>

<div class="flex flex-col gap-1.5" aria-live="polite">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <span class="text-workspace-chrome text-(--solus-text-primary)">
      Code to approve <span class="font-medium">{appAccessLabel(access)}</span>
    </span>
    {#if !countdown}
      <Button
        variant="outline"
        size="sm"
        disabled={connections.appPairingCodeCreating}
        onclick={() => void connections.createAppPairingCode(serverId, access)}
      >
        {connections.appPairingCodeCreating ? "Getting code…" : code ? "New code" : "Get code"}
      </Button>
    {/if}
  </div>
  {#if code && countdown}
    <OutsideAppsCopyRow label="Code" kind="code" value={code.code} />
    <p class="text-chrome-dense tabular-nums text-(--solus-text-tertiary)">{countdown}</p>
  {:else if code}
    <p class="text-chrome-dense text-(--solus-text-tertiary)">The code expired.</p>
  {:else}
    <p class="text-chrome-dense text-(--solus-text-tertiary)">Type it on the app's sign-in page. It works once, for 10 minutes.</p>
  {/if}
  {#if connections.appPairingCodeError}
    <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{connections.appPairingCodeError}</p>
  {/if}
</div>
