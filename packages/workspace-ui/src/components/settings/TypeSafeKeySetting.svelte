<script lang="ts">
  /** The caller's own TypeSafe API key (docs/plans/access-model.md §2.6). It is
   *  its own group on the Tools page because it is a credential, not a tool
   *  switch. A signed-in person keeps it in their Solus account
   *  (docs/plans/cloud-vault.md §2.5): the row shows the account's status and
   *  points there. Only the owner of a host that is not linked saves it here. */
  import { untrack } from "svelte";
  import { CircleCheck as CircleCheckIcon } from "@lucide/svelte";
  import { accountStore, serversStore, sharesStore } from "../../contexts";
  import AccountConnectionRow from "../seats/AccountConnectionRow.svelte";
  import { accountConnectionText, cloudConnectionsPointerUrl, typeSafeAccountStatus } from "../seats/lib/cloud-connections";
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
  const location = $derived(toolState?.typeSafe?.location);
  const disabled = $derived(location !== "host" || !!toolState?.saving || !!toolState?.error);
  const accountConnectionsUrl = $derived(
    cloudConnectionsPointerUrl({
      identity: sharesStore.identities.get(serverId),
      directoryUrl: serversStore.servers.find((server) => server.id === serverId)?.uplink?.directoryUrl,
    }),
  );
  const description = $derived.by(() => {
    if (!location) return "Update or restart this host to add a key.";
    if (location === "account") return accountConnectionText(typeSafeAccountStatus(source));
    if (location === "none") return "Ask Jev needs your own TypeSafe key. A guest has none on this host.";
    if (source === "saved") return "A key is saved. Enter a new one to replace it.";
    if (source === "environment") return "Uses TYPESAFE_API_KEY. A saved key overrides it.";
    return "Lets your agents on this host use Ask Jev.";
  });

  $effect(() => {
    void accountStore.state;
    const targetServerId = serverId;
    untrack(() => void sharesStore.identityFor(targetServerId, true).catch(() => {}));
  });
  // A key in the account changes on the website: read the status again when the window gets focus.
  $effect(() => {
    if (location !== "account") return;
    const targetServerId = serverId;
    const onFocus = () => void store.loadKeyStatus(targetServerId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  async function save(value: string | null) {
    if (await store.saveKey(serverId, value)) apiKey = "";
    input?.focus();
  }
</script>

<SettingsSection label="TypeSafe" {visible}>
  {#if location === "account" && accountConnectionsUrl}
    <AccountConnectionRow
      url={accountConnectionsUrl}
      label="API key"
      status={typeSafeAccountStatus(source)}
      testId="typesafe-row-account"
    />
  {:else}
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
        {#if location === "host"}
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
        {/if}
      {/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>
