<script lang="ts">
  /** "Use your own address" (plans/035 §0.8): the https address of the
   *  person's own ingress, a reverse proxy or a tunnel of their own, saved to
   *  the host setting `publicAddress`. Only a person who may change the host's
   *  settings (`host.admin`) edits it; anyone else sees whom to ask. The gate
   *  and Settings › Sharing & access show it. */
  import { connectionsStore } from "../../../contexts";
  import { hostSettingsStore } from "../../../contexts/app/host-settings.store.svelte";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { localPortOf, publicAddressProblem } from "../lib/app-addresses";
  import { outsideAppsDialog } from "./outside-apps-dialog.svelte";

  interface Props {
    serverId: string;
    hostName: string;
  }

  let { serverId, hostName }: Props = $props();

  const settings = $derived(hostSettingsStore.states.get(serverId));
  const saved = $derived(settings?.publicAddress ?? "");
  const mayChange = $derived(hosts.get(serverId).me.may("host.admin"));
  const localPort = $derived.by(() => {
    const endpoint = connectionsStore.appEndpointFor(serverId);
    return endpoint ? localPortOf(endpoint.localUrl) : null;
  });

  // A draft of the field; null shows the saved value.
  let draft = $state<string | null>(null);
  const value = $derived(draft ?? saved);
  const problem = $derived(draft === null ? null : publicAddressProblem(draft));
  const hasChange = $derived(draft !== null && draft.trim() !== saved);

  async function save() {
    if (draft === null || problem || !settings || settings.saving) return;
    if (await outsideAppsDialog.savePublicAddress(serverId, draft)) draft = null;
  }
</script>

{#if mayChange}
  <form class="flex flex-col gap-2" onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <label for="outside-apps-own-address-{serverId}" class="text-chrome-dense text-(--solus-text-secondary)">Your https address</label>
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <Input
        id="outside-apps-own-address-{serverId}"
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck={false}
        placeholder="https://solus.example.com"
        dictation={false}
        value={value}
        oninput={(event) => (draft = event.currentTarget.value)}
        aria-invalid={problem ? true : undefined}
        class="h-8 min-w-0 flex-1 basis-56 font-mono text-chrome-dense"
      />
      <Button type="submit" size="sm" variant="outline" disabled={!hasChange || !!problem || !settings || settings.saving}>
        {settings?.saving ? "Saving…" : value.trim() === "" && saved !== "" ? "Remove" : "Save"}
      </Button>
    </div>
    {#if problem}
      <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{problem}</p>
    {:else if settings?.error}
      <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{settings.error}</p>
    {/if}
    <p class="text-chrome-dense text-(--solus-text-tertiary)">
      Proxy it to {localPort ? `port ${localPort} on ${hostName}` : `the port of ${hostName}`}, and keep the Host header or forward it as X-Forwarded-Host. Solus keeps only the origin.
    </p>
  </form>
{:else if saved}
  <p class="text-chrome-dense text-(--solus-text-secondary)"><code class="font-mono break-all select-text">{saved}</code></p>
  <p class="text-chrome-dense text-(--solus-text-tertiary)">Only the owner of {hostName} can change it.</p>
{:else}
  <p class="text-chrome-dense text-(--solus-text-secondary)">Ask the owner of {hostName} to set it in Settings › Sharing & access.</p>
{/if}
