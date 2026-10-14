<script lang="ts">
  import { updatesStore } from "../../contexts/updates/updates.store.svelte";
  import { checkAllUpdates } from "../../contexts/updates/check-all-updates";
  import { hostUpdatesStore } from "../../contexts/updates/host-updates.store.svelte";
  import { hostUpdater } from "../../contexts/updates/host-updater.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { updateCommandFor, updateStatusLine } from "./lib/update-status-text";
  import { Button } from "../ui/button";

  let pending = $state(false);
  const state = $derived(updatesStore.state);
  const command = $derived(updateCommandFor(state));
  // The desktop app's own update keeps its place; host updates take the button otherwise.
  const hostUpdates = $derived(updatesStore.isAvailable && command?.command !== "check" ? [] : hostUpdatesStore.installableUpdates);

  async function runCommand() {
    pending = true;
    try {
      if (updatesStore.isAvailable && command?.command === "restart") updatesStore.restart();
      else if (updatesStore.isAvailable && command?.command === "download") await updatesStore.download();
      else if (hostUpdates.length) void hostUpdater.update(hostUpdates);
      else await checkAllUpdates();
    } finally {
      pending = false;
      requestInputFocus();
    }
  }
</script>

<Button
  variant={updatesStore.isReady ? "default" : "ghost"}
  size="sm"
  class="h-6.5 rounded-full px-2.5 text-workspace-chrome font-normal {updatesStore.isReady
    ? ''
    : 'bg-background text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors hover:bg-[var(--wash-1)] dark:hover:bg-[var(--wash-1)]'}"
  disabled={pending || hostUpdater.isRunning || (updatesStore.isAvailable && !command)}
  title={updatesStore.isAvailable ? updateStatusLine(state) : "Check connected hosts for updates"}
  onclick={runCommand}
>
  {#if updatesStore.isAvailable && state.kind === "downloading"}
    Downloading Solus… {Math.round(state.percent)}%
  {:else if pending || (updatesStore.isAvailable && state.kind === "checking")}
    Checking…
  {:else if updatesStore.isReady}
    Restart to update
  {:else if updatesStore.isAvailable && command?.command === "download"}
    Update Solus
  {:else if hostUpdater.isRunning}
    Updating…
  {:else if hostUpdates.length}
    {hostUpdates.length === 1 ? "Install 1 update" : `Install ${hostUpdates.length} updates`}
  {:else}
    Check for updates
  {/if}
</Button>
