<script module lang="ts">
  /** Search words, read by the settings page through the Host page. */
  export const searchWords = ["webhook", "public url", "hold", "offline", "reverse proxy", "ngrok"];
</script>

<script lang="ts">
  /** The host's webhook settings (docs/plans/webhooks.md §2.2, §2.3): its public
   *  URL, and for a linked host whether Solus Cloud holds requests while it is
   *  offline. */
  import { untrack } from "svelte";
  import { webhooksStore } from "../../contexts/webhooks/webhooks.store.svelte";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";

  let { serverId, visible = true }: { serverId: string; visible?: boolean } = $props();

  $effect(() => untrack(() => webhooksStore.watch()));

  const settings = $derived(webhooksStore.hostSettings.get(serverId));
  let isSaving = $state(false);
  let error = $state("");

  async function save(patch: { publicUrl?: string | null; holdWhileOffline?: boolean }) {
    if (isSaving) return;
    isSaving = true;
    error = "";
    try {
      await webhooksStore.saveHostSettings(serverId, patch);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not save the setting.";
    } finally {
      isSaving = false;
    }
  }
</script>

<SettingsSection label="Webhooks" {visible}>
  <SettingsRow
    label="Public URL"
    description={error || "The address where you expose this host, for example through a reverse proxy. Direct webhook URLs start with it. Empty: no direct URL."}
  >
    {#snippet control()}
      <Input
        type="url"
        placeholder="https://"
        value={settings?.publicUrl ?? ""}
        disabled={!settings || isSaving}
        aria-label="Public URL"
        class="w-64"
        onchange={(event) => void save({ publicUrl: event.currentTarget.value.trim() || null })}
      />
    {/snippet}
  </SettingsRow>
  {#if settings && settings.holdWhileOffline !== null}
    <SettingsRow
      label="Hold webhooks while offline"
      description="Solus Cloud keeps requests for up to 24 hours while this host is offline, and sends them when it is online again. Off: requests fail, and Solus Cloud deletes the requests it holds."
    >
      {#snippet control()}
        <Switch
          checked={settings.holdWhileOffline === true}
          disabled={isSaving}
          aria-label="Hold webhooks while offline"
          onCheckedChange={(hold) => void save({ holdWhileOffline: hold })}
        />
      {/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>
