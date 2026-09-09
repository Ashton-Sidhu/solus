<script lang="ts">
  import { updatesStore } from "../../contexts/updates/updates.store.svelte";
  import { checkAllUpdates } from "../../contexts/updates/check-all-updates";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { updateCommandFor, updateStatusLine } from "./lib/update-status-text";
  import { Button } from "../ui/button";

  let pending = $state(false);
  const state = $derived(updatesStore.state);
  const command = $derived(updateCommandFor(state));

  async function runCommand() {
    pending = true;
    try {
      if (updatesStore.isAvailable && command?.command === "restart") updatesStore.restart();
      else if (updatesStore.isAvailable && command?.command === "download") await updatesStore.download();
      else await checkAllUpdates();
    } finally {
      pending = false;
      requestInputFocus();
    }
  }
</script>

<Button
  variant={updatesStore.isReady ? "default" : "outline"}
  size="sm"
  class="text-workspace-chrome"
  disabled={pending || (updatesStore.isAvailable && !command)}
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
  {:else}
    Check for updates
  {/if}
</Button>
