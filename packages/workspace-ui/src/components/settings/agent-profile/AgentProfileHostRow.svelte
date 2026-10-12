<script lang="ts">
  /**
   * One host the profile applies to: what it holds and where that came from,
   * with Copy (the desktop pushes, while sync is off), Pull (the host reads the
   * account, while sync is on), and Remove.
   */
  import { RefreshCw as CopyIcon, Trash2 as RemoveIcon } from "@lucide/svelte";
  import { agentProfileStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { agentProfileDescription } from "../../seats/lib/agent-profile-copy";
  import SettingsRow from "../SettingsRow.svelte";
  import { Button } from "../../ui/button";

  interface Props {
    serverId: string;
    label: string;
    syncOn: boolean;
  }

  let { serverId, label, syncOn }: Props = $props();

  const status = $derived(agentProfileStore.statuses.get(serverId));
  const busy = $derived(agentProfileStore.busy.has(serverId));

  // The row is the one reader of a host's status; it asks when it appears.
  $effect(() => {
    void agentProfileStore.load(serverId);
  });

  async function copy() {
    await agentProfileStore.copy(serverId);
    requestInputFocus();
  }

  async function pull() {
    await agentProfileStore.pull(serverId);
    requestInputFocus();
  }

  async function remove() {
    await agentProfileStore.remove(serverId);
    requestInputFocus();
  }
</script>

<SettingsRow
  {label}
  description={agentProfileDescription(status, agentProfileStore.errors.get(serverId), agentProfileStore.canCopy)}
  testId="agent-profile-row"
>
  {#snippet control()}
    <div class="flex items-center gap-2">
      {#if status?.syncedAt}
        <Button variant="ghost" size="sm" disabled={busy} onclick={() => void remove()}>
          <RemoveIcon size={13} />
          Remove
        </Button>
      {/if}
      {#if syncOn}
        <Button variant="outline" size="sm" disabled={busy} onclick={() => void pull()}>
          <CopyIcon size={13} class={busy ? "animate-spin motion-reduce:animate-none" : ""} />
          Pull now
        </Button>
      {:else if agentProfileStore.canCopy}
        <Button variant="outline" size="sm" disabled={busy} onclick={() => void copy()}>
          <CopyIcon size={13} class={busy ? "animate-spin motion-reduce:animate-none" : ""} />
          {status?.syncedAt ? "Copy again" : "Copy now"}
        </Button>
      {/if}
    </div>
  {/snippet}
</SettingsRow>
