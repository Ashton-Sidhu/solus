<script lang="ts">
  /**
   * One host the profile applies to: whether it is registered to the account
   * (changed on the host's Access page), what it holds and where that came
   * from, with Copy (the desktop pushes, signed out), Pull (the host reads the
   * account, signed in), and Remove.
   */
  import { RefreshCw as CopyIcon, Trash2 as RemoveIcon } from "@lucide/svelte";
  import { agentProfileStore, uplinkStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { agentProfileDescription, hostLinkLabel } from "../../seats/lib/agent-profile-copy";
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
  const link = $derived(hostLinkLabel(uplinkStore.statusFor(serverId)));

  // The row is the one reader of a host's status and its link; it asks when it appears.
  $effect(() => {
    void agentProfileStore.load(serverId);
    void uplinkStore.refresh(serverId);
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
  description={`${link} ${agentProfileDescription(status, agentProfileStore.errors.get(serverId), agentProfileStore.canCopy)}`}
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
