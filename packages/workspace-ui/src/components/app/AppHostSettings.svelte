<script lang="ts">
  /** A host's settings for its published apps (docs/plans/app-deploy.md §8.2):
   *  the Tailscale auth key that the sidecar of a copy joins the tailnet with.
   *  A value is never read back: the row says only that the host has one. */
  import { untrack } from "svelte";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";

  let { serverId, visible = true }: { serverId: string; visible?: boolean } = $props();

  $effect(() => {
    const hostId = serverId;
    untrack(() => void appsStore.loadPublishPlaces(hostId));
  });
  /** Undefined until the host answers, and for a host that does not publish apps. */
  const places = $derived(appsStore.publishPlacesFor(serverId));

  let draft = $state("");
  let isEditing = $state(false);
  let isSaving = $state(false);
  let error = $state("");

  async function save(value: string | null) {
    if (isSaving) return;
    isSaving = true;
    error = "";
    try {
      await appsStore.setTailscaleKey(serverId, value);
      draft = "";
      isEditing = false;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not save the key.";
    } finally {
      isSaving = false;
    }
  }
</script>

<SettingsSection label="Published apps" visible={visible && places !== undefined}>
  <SettingsRow
    label="Tailscale auth key"
    description={error || "A published app with a Tailscale address joins your tailnet with this key. Make a reusable key in the Tailscale admin console. The key stays on this host and is never shown again."}
    testId="app-host-tailscale-key"
  >
    {#snippet control()}
      {#if isEditing || !places?.hasTailscaleKey}
        <Input
          type="password"
          dictation={false}
          autocomplete="off"
          spellcheck={false}
          data-1p-ignore
          class="w-56"
          placeholder="tskey-auth-…"
          aria-label="Tailscale auth key"
          disabled={isSaving}
          value={draft}
          oninput={(event) => (draft = event.currentTarget.value)}
          submitOn="enter"
          onSubmit={() => draft.trim() && void save(draft.trim())}
        />
        {#if isEditing}
          <Button size="default" variant="ghost" class="text-muted-foreground pointer-coarse:min-h-11" disabled={isSaving} onclick={() => { isEditing = false; draft = ""; }}>Cancel</Button>
        {/if}
        <Button size="default" class="pointer-coarse:min-h-11" disabled={isSaving || draft.trim() === ""} onclick={() => void save(draft.trim())}>{isSaving ? "Saving…" : "Save"}</Button>
      {:else}
        <span class="text-[13px] text-muted-foreground">A key is saved</span>
        <Button size="sm" variant="destructive" class="pointer-coarse:min-h-11" disabled={isSaving} onclick={() => void save(null)}>Remove</Button>
        <Button size="sm" variant="outline" class="pointer-coarse:min-h-11" disabled={isSaving} onclick={() => (isEditing = true)}>Replace</Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>
