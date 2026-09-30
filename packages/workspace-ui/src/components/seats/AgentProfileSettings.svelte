<script lang="ts">
  /**
   * Settings → Providers → Your agent profile (docs/agent-profile.md): your
   * own instructions and skills on this host — in your seats as an
   * organization member, or in the host's own homes on a host you own. Solus on the member's computer copies them; any client shows the copy
   * and can remove it.
   */
  import { RefreshCw as CopyIcon, Trash2 as RemoveIcon } from "@lucide/svelte";
  import { agentProfileStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import { agentProfileDescription } from "./lib/agent-profile-copy";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const applies = $derived(agentProfileStore.applies.get(serverId) === true);
  const status = $derived(agentProfileStore.statuses.get(serverId));
  const busy = $derived(agentProfileStore.busy.has(serverId));

  $effect(() => {
    if (applies) void agentProfileStore.load(serverId);
  });

  async function copy() {
    await agentProfileStore.copy(serverId);
    requestInputFocus();
  }

  async function remove() {
    await agentProfileStore.remove(serverId);
    requestInputFocus();
  }
</script>

<SettingsSection label="Your agent profile" visible={applies}>
  <SettingsRow
    label="Instructions and skills"
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
        {#if agentProfileStore.canCopy}
          <Button variant="outline" size="sm" disabled={busy} onclick={() => void copy()}>
            <CopyIcon size={13} class={busy ? "animate-spin motion-reduce:animate-none" : ""} />
            {status?.syncedAt ? "Copy again" : "Copy now"}
          </Button>
        {/if}
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>
