<script lang="ts">
  /** The TypeSafe API key for this host. It is its own group on the Tools page
   *  because it is a credential, not a tool switch: Ask Jev reads it, but the
   *  key outlives any one tool preference. */
  import { CircleCheck as CircleCheckIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { solusToolsStore as store } from "./solus-tools.store.svelte";

  let { serverId, visible = true }: { serverId: string; visible?: boolean } = $props();
  let apiKey = $state("");
  let input = $state<HTMLInputElement | null>(null);
  const toolState = $derived(store.states.get(serverId));
  const source = $derived(toolState?.typeSafe?.source ?? null);
  const disabled = $derived(!toolState?.typeSafe || toolState.saving || !!toolState.error);
  const description = $derived.by(() => {
    if (!toolState?.typeSafe) return "Update or restart this host to configure a TypeSafe API key.";
    if (source === "saved") return "A key is saved on this host. Enter a new key to replace it.";
    if (source === "environment") return "This host uses TYPESAFE_API_KEY. A saved key takes priority.";
    return "Add a key to make Ask Jev available to agents on this host.";
  });

  async function save(value: string | null) {
    if (await store.saveKey(serverId, value)) apiKey = "";
    input?.focus();
  }
</script>

<SettingsSection label="TypeSafe" {visible}>
  <SettingsRow label="API key" {description}>
    {#snippet labelExtra()}
      {#if source}
        <CircleCheckIcon
          size={13}
          role="img"
          aria-label="A TypeSafe API key is configured"
          class="ml-1.5 inline-block shrink-0 align-[-0.15em] text-(--solus-status-complete)"
        />
      {/if}
    {/snippet}
    {#snippet body()}
      <form class="flex flex-wrap items-center gap-2" onsubmit={(event) => { event.preventDefault(); void save(apiKey.trim()); }}>
        <Input bind:ref={input} bind:value={apiKey} id="typesafe-api-key" type="password" autocomplete="new-password"
          aria-label="TypeSafe API key" placeholder={source === "saved" ? "Enter a new key" : "Enter API key"}
          maxlength={4096} {disabled} class="min-w-48 flex-1 text-workspace-chrome" />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || !apiKey.trim()}>
          {toolState?.saving ? "Saving…" : source === "saved" ? "Replace key" : "Save key"}
        </Button>
        {#if source === "saved"}
          <Button type="button" variant="ghost" size="sm" {disabled} onclick={() => void save(null)}>Remove key</Button>
        {/if}
      </form>
    {/snippet}
  </SettingsRow>
</SettingsSection>
